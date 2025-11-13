import 'dotenv/config';
import { type BrowserContext, chromium, type Page } from 'playwright';

const NON_DIGIT_REGEX = /[^\d]/g;
const MINIMUM_AMOUNT = 5000;
const TARGET_PAGE_PATTERNS = ['game645.do?method=buyLotto'];

function validateEnvironmentVariables() {
  console.log('[환경변수 검증 시작]');

  const id = process.env.DHLOTTERY_ID;
  const pw = process.env.DHLOTTERY_PASSWORD;

  console.log(`DHLOTTERY_ID 설정 여부: ${id ? '✓ 설정됨' : '✗ 미설정'}`);
  console.log(`DHLOTTERY_PASSWORD 설정 여부: ${pw ? '✓ 설정됨' : '✗ 미설정'}`);

  if (!id || !pw) {
    console.error(
      '\n❌ 환경변수 DHLOTTERY_ID, DHLOTTERY_PASSWORD가 설정되지 않았습니다.',
    );
    console.error('GitHub Secrets 설정을 확인하세요.');
    process.exit(1);
  }

  console.log('[환경변수 검증 완료]\n');
  return { id, pw };
}

/**
 * 모든 열린 페이지 중에서 타겟 패턴과 일치하는 페이지를 찾아 반환
 * @param context - Browser context
 * @param targetPatterns - URL 패턴 배열
 * @returns Promise<Page | null>
 */
async function findTargetPage(
  context: BrowserContext,
  targetPatterns: string[],
): Promise<Page | null> {
  const pages = context.pages();

  for (const page of pages) {
    const url = page.url();
    const isTargetPage = targetPatterns.some((pattern) =>
      url.includes(pattern),
    );

    if (isTargetPage) {
      console.log(`타겟 페이지 찾음: ${url}`);
      // 페이지에 포커스 설정
      await page.bringToFront();
      return page;
    }
  }

  return null;
}

/**
 * 팝업 감지 및 처리
 * @param context - Browser context
 */
function setupPopupHandler(context: BrowserContext) {
  context.on('page', async (page: Page) => {
    // 비동기로 처리하여 메인 로직을 차단하지 않도록 함
    setTimeout(async () => {
      try {
        const url = page.url();
        console.log(`[팝업/새창 감지] ${url}`);

        // 광고 관련 URL 패턴
        const adPatterns = [
          'ad.dhlottery.co.kr',
          'popup',
          'banner',
          'event',
          'notice',
          'popupOne',
        ];

        const isAdPopup = adPatterns.some((pattern) =>
          url.toLowerCase().includes(pattern),
        );

        if (isAdPopup) {
          console.log(`[광고 팝업 자동 닫기] ${url}`);
          // 약간의 지연 후 닫기
          await new Promise((resolve) => setTimeout(resolve, 500));
          await page.close().catch(() => {
            console.log(`[팝업 닫기 실패] ${url}`);
          });
        }
      } catch (error) {
        console.log(`[팝업 처리 오류] ${error}`);
      }
    }, 100);
  });
}

(async () => {
  console.log('🚀 동행복권 자동화 시작');

  // 환경변수 검증
  const { id, pw } = validateEnvironmentVariables();

  // CI 환경 감지
  const isCI =
    process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

  console.log(`환경: ${isCI ? 'CI' : '로컬'}`);

  const browser = await chromium.launch({
    headless: isCI, // CI에서는 headless 모드
    args: [
      '--disable-popup-blocking', // 팝업 차단 비활성화
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox', // CI 환경에서 필요
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // 메모리 부족 방지
    ],
  });

  const context = await browser.newContext({
    // 팝업 관련 권한 설정
    bypassCSP: true,
    javaScriptEnabled: true,
  });

  // 팝업 핸들러 설정
  setupPopupHandler(context);

  const page = await context.newPage();

  // 이미지 리소스 차단으로 성능 최적화
  await context.route('**.jpg', (route) => route.abort());

  console.log('[1단계] 메인 페이지 접속');
  await page.goto('https://dhlottery.co.kr/common.do?method=main', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  // 팝업들이 열리고 닫히는 시간을 기다림
  await page.waitForTimeout(2000);

  try {
    // 로그인
    console.log('[2단계] 로그인 진행');

    // 로그인 링크가 나타날 때까지 대기
    await page.waitForSelector('a:has-text("로그인")', { timeout: 10000 });
    await page.getByRole('link', { name: '로그인' }).click();
    await page.waitForLoadState('domcontentloaded');

    await page.locator('input[name="userId"]').fill(id);
    await page.locator('input[name="password"]').fill(pw);
    await page.getByRole('group').getByRole('link', { name: '로그인' }).click();

    // 로그인 후 페이지 로드 대기
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    // 비밀번호 변경 안내 페이지 확인 및 회피
    console.log('[2-1단계] 비밀번호 변경 안내 확인');
    try {
      const passwordChangeTitle = page.locator(
        '.header_article .sub_title:has-text("비밀번호 변경안내")',
      );
      const isPasswordChangePage = await passwordChangeTitle.isVisible({
        timeout: 3000,
      });

      if (isPasswordChangePage) {
        console.log('[비밀번호 변경 안내 감지] "다음에 변경" 클릭');
        await page.locator('a.btn_common.lrg:has-text("다음에 변경")').click();
        await page.waitForLoadState('networkidle', { timeout: 10000 });
        console.log('[비밀번호 변경 안내 우회 완료]');
      }
    } catch {
      console.log('[비밀번호 변경 안내 없음] - 계속 진행');
    }

    // 예치금 셀렉터 대기
    await page.waitForSelector(
      'form[name="frmLogin"] .topAccount ul.information li.money strong',
      { timeout: 10000 },
    );

    // 예치금 확인
    const depositAmount = await page
      .locator(
        'form[name="frmLogin"] .topAccount ul.information li.money strong',
      )
      .textContent();
    const amountNumber = depositAmount
      ? Number.parseInt(depositAmount.replace(NON_DIGIT_REGEX, ''), 10)
      : 0;

    console.log(`[3단계] 예치금 확인: ${depositAmount}`);

    if (amountNumber < MINIMUM_AMOUNT) {
      throw new Error(`예치금이 부족합니다 (${amountNumber}원)`);
    }

    // 로또 페이지 이동
    console.log('[4단계] 로또 구매 페이지로 이동');
    await page.getByText('복권구매').hover();

    // 새 페이지/팝업 감지를 위한 Promise
    const pagePromise = context.waitForEvent('page', {
      predicate: (page) => {
        const url = page.url();
        return TARGET_PAGE_PATTERNS.some((pattern) => url.includes(pattern));
      },
      timeout: 10000,
    });

    // 클릭 실행
    await page.locator('#gnb .gnb1_1 a').click();

    // 새 페이지 대기
    let newPage: Page;
    try {
      newPage = await pagePromise;
      console.log(`[새 페이지 열림] ${newPage.url()}`);
    } catch {
      // timeout 시 현재 열린 페이지 중에서 찾기
      const targetPage = await findTargetPage(context, TARGET_PAGE_PATTERNS);
      if (!targetPage) {
        throw new Error('로또 구매 페이지를 찾을 수 없습니다');
      }
      newPage = targetPage;
    }

    // 새 페이지에 포커스 설정
    await newPage.bringToFront();
    await newPage.waitForLoadState('networkidle');

    // iframe 대기
    console.log('[5단계] iframe 로딩 대기');
    await newPage.waitForSelector('#ifrm_tab', { timeout: 10000 });
    const iframe = newPage.frameLocator('#ifrm_tab');

    // 페이지 안정화를 위한 대기
    await newPage.waitForTimeout(3000);

    // 판매시간 확인
    console.log('[6단계] 판매시간 확인');
    const saleTimePopup = iframe.locator('#popupLayerAlert .layer-message');

    try {
      const isPopupVisible = await saleTimePopup.isVisible({ timeout: 2000 });

      if (isPopupVisible) {
        const alertMessage = await saleTimePopup.textContent();
        if (alertMessage?.includes('현재 시간은 판매시간이 아닙니다')) {
          console.log('❌ 현재 판매시간이 아닙니다');
          await iframe.locator('#popupLayerAlert .button.confirm').click();
          await newPage.close();
          return;
        }
      }
    } catch {
      console.log('판매시간 팝업 없음 - 계속 진행');
    }

    // 로또 구매
    console.log('[7단계] 로또 번호 자동 선택');
    await iframe.locator('#tabWay2Buy #num2').click();
    await iframe.locator('#divWay2Buy1 .amount #amoundApply').selectOption('5');
    await iframe.locator('#divWay2Buy1 .amount input[type="button"]').click();

    console.log('[8단계] 구매 진행');
    await iframe.locator('.selected-games .footer #btnBuy').click();
    await iframe
      .locator('#popupLayerConfirm .btns input[value="확인"]')
      .click();

    // 구매한도 확인
    try {
      const limitPopup = iframe.locator('#recommend720Plus');
      const isLimitPopupVisible = await limitPopup.isVisible({ timeout: 2000 });

      if (isLimitPopupVisible) {
        console.log('❌ 이번 주 구매한도를 초과했습니다');
        await iframe
          .locator(
            '#recommend720Plus .btns a[href="javascript:closeRecomd720Popup();"]',
          )
          .click();
        await newPage.close();
        return;
      }
    } catch {
      console.log('구매한도 팝업 없음 - 계속 진행');
    }

    // 구매 완료
    console.log('[9단계] 구매 완료 대기');
    await iframe.locator('#popReceipt').waitFor({
      state: 'visible',
      timeout: 10000,
    });

    const round = await iframe.locator('#popReceipt #buyRound').textContent();
    const issueDate = await iframe
      .locator('#popReceipt #issueDay')
      .textContent();
    const buyAmount = await iframe
      .locator('#popReceipt #nBuyAmount')
      .textContent();

    console.log(`\n✅ 구매 완료!`);
    console.log(`${round || ''}`);
    console.log(`발행일: ${issueDate || ''}`);
    console.log(`금액: ${buyAmount || ''}원`);

    const lottoNumbers = await iframe
      .locator('#popReceipt #reportRow li')
      .all();
    for (const lottoNumber of lottoNumbers) {
      const gameLabel = await lottoNumber
        .locator('strong span')
        .first()
        .textContent();
      const numbers = await lottoNumber.locator('.nums span').allTextContents();
      console.log(`${gameLabel || ''}게임: ${numbers.join(', ')}`);
    }

    await iframe.locator('#popReceipt #closeLayer').click();
    await newPage.close();
  } catch (error) {
    console.error(`❌ 오류 발생: ${error}`);

    // CI 환경에서 스크린샷 저장
    const isCI =
      process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
    if (isCI) {
      try {
        const pages = context.pages();
        for (let i = 0; i < pages.length; i++) {
          const p = pages[i];
          if (p) {
            await p
              .screenshot({
                path: `error-screenshot-${i}.png`,
                fullPage: true,
              })
              .catch(() => console.log(`스크린샷 저장 실패: 페이지 ${i}`));
          }
        }
      } catch (screenshotError) {
        console.error(`스크린샷 저장 중 오류: ${screenshotError}`);
      }
    }

    // 현재 열린 모든 페이지 정보 출력 (디버깅용)
    const pages = context.pages();
    console.log(`\n[디버그] 열린 페이지 수: ${pages.length}`);
    for (const p of pages) {
      console.log(`  - ${p.url()}`);
    }

    // 스택 트레이스 출력
    if (error instanceof Error) {
      console.error(`\n[에러 상세]`);
      console.error(`메시지: ${error.message}`);
      console.error(`스택: ${error.stack}`);
    }

    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((error) => {
  console.error(`\n❌ 프로그램 종료: ${error}`);
  process.exit(1);
});
