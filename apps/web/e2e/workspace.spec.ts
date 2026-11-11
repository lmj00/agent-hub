import { test as base, expect, type Page, type BrowserContext } from "@playwright/test";

// Application scenarios share one valid login while keeping separate browser
// contexts. Repeated setup sign-ins must not consume the real rate-limit window.
const test = base.extend<
  {},
  { authenticatedCookies: Awaited<ReturnType<BrowserContext["cookies"]>> }
>({
  authenticatedCookies: [
    async ({ browser }, use) => {
      const context = await browser.newContext({ baseURL: "http://127.0.0.1:4320" });
      try {
        await login(await context.newPage());
        await use(await context.cookies());
      } finally {
        await context.close();
      }
    },
    { scope: "worker" },
  ],
  context: async ({ context, authenticatedCookies }, use) => {
    await context.addCookies(authenticatedCookies);
    await use(context);
  },
});

async function login(page: Page) {
  await page.goto("/#login");
  const signedIn = page.getByRole("button", { name: "로그아웃", exact: true });
  await expect(signedIn.or(page.getByLabel("비밀번호", { exact: true }))).toBeVisible();
  if (await signedIn.isVisible()) return;
  await page.getByLabel("비밀번호", { exact: true }).fill("browser-fixture-password");
  const response = page.waitForResponse(
    (value) => value.url().endsWith("/auth/login") && value.request().method() === "POST",
  );
  await page.getByRole("button", { name: "작업 공간 열기" }).click();
  const result = await response;
  expect(result.status()).toBe(200);
  await expect(signedIn).toBeVisible();
}
async function createProject(page: Page, name: string) {
  await page.getByRole("button", { name: "프로젝트 등록 +", exact: true }).click();
  await page.getByLabel("프로젝트 이름", { exact: true }).fill(name);
  await page.getByLabel("작업 공간 키", { exact: true }).fill("example");
  await page.getByRole("button", { name: "프로젝트 등록", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}
async function openSection(page: Page, name: "작업" | "목표" | "설정") {
  await page
    .getByRole("navigation", { name: "프로젝트 메뉴" })
    .getByRole("button", { name, exact: true })
    .click();
}
async function createTask(page: Page, instruction: string) {
  await openSection(page, "작업");
  const composer = page.locator(".analysis-composer");
  if (!(await composer.evaluate((element) => (element as HTMLDetailsElement).open)))
    await composer.locator("summary").click();
  await page.getByLabel("분석 작업 등록", { exact: true }).fill(instruction);
  await page.getByRole("button", { name: "분석 요청", exact: true }).click();
  await expect(page.locator("#detail-heading")).toHaveText(instruction);
}

test("marks publication uncertain after a lost write response and rechecks before another save", async ({
  page,
}, testInfo) => {
  await login(page);
  await createProject(page, "공개 응답 유실 확인");
  await openSection(page, "설정");
  const panel = page.getByRole("region", { name: "프로젝트 공개 설정" });
  await panel.locator("summary").click();
  await expect(panel.locator("summary > span")).toHaveText("비공개");
  await panel.getByLabel("공개용 이름", { exact: true }).fill("확인할 공개 이름");
  await panel.getByLabel("방문자에게 공개", { exact: true }).check();
  let publicationPath = "";
  await page.route("**/projects/*/publication", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    publicationPath = new URL(route.request().url()).pathname;
    await route.fetch();
    await route.abort("failed");
  });
  await panel.getByRole("button", { name: "공개 설정 저장" }).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  const persisted = await page.request.get(publicationPath);
  expect(persisted.ok()).toBe(true);
  expect((await persisted.json()).listed).toBe(true);
  await expect(panel.locator("summary > span")).toHaveText("확인 필요");
  await expect(panel.getByRole("button", { name: "공개 설정 저장" })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("publication-uncertain.png"), fullPage: true });
  await page.unroute("**/projects/*/publication");
  let releaseRead!: () => void;
  const pendingRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  await page.route("**/projects/*/publication", async (route) => {
    const response = await route.fetch();
    await pendingRead;
    await route.fulfill({ response });
  });
  try {
    await panel.getByRole("button", { name: "다시 확인", exact: true }).click();
    await expect(panel.locator("summary > span")).toHaveText("확인 중");
    await expect(panel.getByRole("button", { name: "공개 설정 저장" })).toBeDisabled();
    await expect(panel.getByLabel("방문자에게 공개", { exact: true })).toBeDisabled();
  } finally {
    releaseRead();
  }
  await expect(panel.locator("summary > span")).toHaveText("공개");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await page.unroute("**/projects/*/publication");
  await panel.getByLabel("방문자에게 공개", { exact: true }).uncheck();
  await panel.getByRole("button", { name: "공개 설정 저장" }).click();
  await expect(panel.locator("summary > span")).toHaveText("비공개");
  expect((await (await page.request.get(publicationPath)).json()).listed).toBe(false);
});

test("creates a private project with a stable request key and explains uncertain writes without a retry button", async ({
  page,
}, testInfo) => {
  await login(page);
  const id = "b3b0d7b5-35ac-4b12-a6b5-6b8061cb3e41";
  const posts: Record<string, unknown>[] = [];
  let job: Record<string, unknown> | undefined;
  await page.route("**/integrations/github", (route) =>
    route.fulfill({ json: { configured: true } }),
  );
  await page.route("**/integrations/github/creations", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      posts.push(body);
      job ??= {
        id,
        repositoryName: body.repositoryName,
        name: body.name,
        profile: body.profile,
        status: "creating",
        attempt: 1,
        repositoryId: null,
        fullName: null,
        importId: null,
        errorCode: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (posts.length === 1) await route.abort("failed");
      else await route.fulfill({ status: 202, json: job });
    } else
      await route.fulfill({
        json: { enabled: true, profiles: ["node"], creations: job ? [job] : [] },
      });
  });
  await page.reload();
  const panel = page.getByRole("region", { name: "GitHub 저장소 연결", exact: true });
  await panel.locator("summary").click();
  const creation = panel.getByRole("region", { name: "새 프로젝트 만들기", exact: true });
  await creation.getByLabel("GitHub 저장소 이름", { exact: true }).fill("language-app");
  await creation.getByLabel("화면에 표시할 프로젝트 이름").fill("내 언어 공부 앱");
  await creation.getByRole("button", { name: "비공개 저장소 만들기", exact: true }).click();
  await expect(creation.getByRole("alert")).toBeVisible();
  await creation.getByRole("button", { name: "비공개 저장소 만들기", exact: true }).click();
  await expect(creation).toContainText("GitHub 저장소 생성 중");
  expect(posts).toHaveLength(2);
  expect(posts[0]).toEqual(posts[1]);
  expect(posts[0]).toMatchObject({
    repositoryName: "language-app",
    name: "내 언어 공부 앱",
    profile: "node",
  });
  job = { ...job, status: "uncertain", errorCode: "GITHUB_CREATE_UNCERTAIN" };
  await creation.getByRole("button", { name: "생성 상태 새로고침" }).click();
  await expect(creation).toContainText("GitHub에서 이 저장소의 생성 여부를 직접 확인");
  await expect(creation.getByRole("button", { name: "생성 다시 요청", exact: true })).toHaveCount(
    0,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("github-creation-mobile.png"),
    fullPage: true,
  });
  job = {
    ...job,
    status: "linked",
    repositoryId: 78,
    fullName: "fixture-owner/language-app",
    importId: "a3b0d7b5-35ac-4b12-a6b5-6b8061cb3e41",
    errorCode: null,
  };
  await creation.getByRole("button", { name: "생성 상태 새로고침" }).click();
  await expect(creation).toContainText("가져오기 요청 완료");
  await expect(creation).toContainText("준비 상태를 확인하고 프로젝트를 여세요");
});

test("distinguishes Goal completion from successful review and incomplete checks on desktop and mobile", async ({
  page,
}, testInfo) => {
  await login(page);
  await page.getByRole("button", { name: /목표 완료 검증 예제 example/ }).click();
  await page.getByRole("button", { name: /목표 완료 이력/ }).click();
  const panel = page.getByRole("region", { name: "목표 전체 검증 기록", exact: true });
  await expect(panel).toContainText("목표 완료 기록됨");
  await expect(panel).toContainText("목표 완료와 이력을 함께 저장했습니다");
  await panel.getByText("테스트 출력 보기", { exact: true }).click();
  await expect(panel).toContainText("2 tests passed");
  await panel.getByText("검증한 코드 버전 보기", { exact: true }).click();
  await expect(panel.locator("code")).toHaveCount(2);
  await page.screenshot({
    path: testInfo.outputPath("goal-verification-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("goal-verification-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: /검토만 통과한 기록/ }).click();
  await expect(panel).toContainText("목표 검증 통과");
  await expect(panel).toContainText("목표 완료가 저장된 기록은 아직 없습니다");
  await expect(panel).not.toContainText("목표 완료 기록됨");
  await page.getByRole("button", { name: /목표 보완 검토 기록/ }).click();
  await expect(panel).toContainText("목표 보완 필요");
  await expect(panel).toContainText("오류 입력 처리 확인 필요");
  await panel.getByText("테스트 출력 보기", { exact: true }).click();
  await expect(panel.locator("pre")).toContainText("<script>");
  expect(await page.evaluate(() => "goalUnwanted" in window)).toBe(false);
  await page.reload();
  await page.getByRole("button", { name: /목표 완료 검증 예제 example/ }).click();
  await page.getByRole("button", { name: /목표 완료 이력/ }).click();
  await expect(panel).toContainText("목표 완료 기록됨");
});

test("distinguishes selected, loaded and unknown runtime skills across attempts on desktop and mobile", async ({
  page,
}, testInfo) => {
  await login(page);
  await page.getByRole("button", { name: /지침 기록 예제 example/ }).click();
  await page.getByRole("button", { name: /읽기 확인 기록/ }).click();
  const panel = page.getByRole("region", { name: "에이전트 지침 기록", exact: true });
  await expect(panel).toContainText("분석 · 지침 읽기 확인");
  await expect(page.locator(".detail-top .status-blocked")).toBeVisible();
  await panel.getByText("1. 분석 · 지침 읽기 확인", { exact: true }).click();
  await expect(panel).toContainText("제품용 1 · gstack 1.93.11.0");
  await expect(panel).toContainText("전체 gstack 도구 실행을 의미하지 않습니다");
  await panel.getByText("버전 대조 정보", { exact: true }).click();
  await expect(panel).toContainText("adapted_instructions");
  await expect(panel.locator("code")).toHaveCount(3);
  await page.screenshot({
    path: testInfo.outputPath("runtime-skills-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("runtime-skills-mobile.png"), fullPage: true });
  await page.locator(".attempts button").last().click();
  await expect(panel).toContainText("이 실행에는 지침 적용을 확인할 기록이 없습니다");
  await expect(panel).toContainText("지침 기록 없음");
  await expect(panel).not.toContainText("지침 읽기 확인");
  await page.getByRole("button", { name: /선택만 된 기록/ }).click();
  await expect(panel).toContainText("계획 · 선택됨 · 읽기 미확인");
  await panel.getByText("1. 계획 · 선택됨 · 읽기 미확인", { exact: true }).click();
  await expect(panel).toContainText("선택 기록만 있습니다");
  await expect(panel).not.toContainText("지침 읽기 확인");
  await page.getByRole("button", { name: /선택 전 중단 기록/ }).click();
  await expect(panel).toContainText("지침 기록 없음");
  await expect(panel).not.toContainText("이 실행에는 지침 적용을 확인할 기록이 없습니다");
  await page.reload();
  await page.getByRole("button", { name: /지침 기록 예제 example/ }).click();
  await page.getByRole("button", { name: /읽기 확인 기록/ }).click();
  await expect(panel).toContainText("분석 · 지침 읽기 확인");
});

test("shows failed development feedback and the later verified candidate without declaring the Task complete", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: /개발 검증 예제 example/ }).click();
  await page.getByRole("button", { name: /계산 오류 수정 기록/ }).click();
  const evidence = page.getByRole("region", { name: "개발·검증 기록", exact: true });
  await expect(page.locator(".detail-top .status-blocked")).toBeVisible();
  await expect(evidence).toContainText("2 / 3회 수정");
  await expect(evidence).toContainText(
    "검증을 통과해도 변경 반영이 확인되기 전에는 작업이 완료되지 않습니다",
  );
  const latest = evidence.locator(".development-round").last();
  await expect(latest).toHaveAttribute("open", "");
  await expect(latest).toContainText("검증 완료");
  await expect(evidence).toContainText("변경 반영 기록 없음");
  await expect(latest).toContainText("종료 코드 0");
  await expect(latest.getByText("승인", { exact: true })).toBeVisible();
  await latest.getByText("변경 파일 1개", { exact: true }).click();
  await expect(latest).toContainText("src/calculate.ts");
  const failed = evidence.locator(".development-round").first();
  await failed.locator("summary").first().click();
  await expect(failed).toContainText("보완 필요");
  await expect(failed).toContainText("종료 코드 1");
  await expect(failed).toContainText("곱셈으로 계산식을 수정하세요");
  await failed.getByText("테스트 출력", { exact: true }).click();
  await expect(failed.locator(".development-output")).toContainText("AssertionError");
  await expect(failed.locator(".development-output")).toContainText("<script>");
  expect(await page.evaluate(() => "developmentUnwanted" in window)).toBe(false);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: /개발 검증 예제 example/ }).click();
  await page.getByRole("button", { name: /계산 오류 수정 기록/ }).click();
  await expect(evidence).toContainText("2 / 3회 수정");
  await expect(page.locator(".detail-top .status-blocked")).toBeVisible();
});

test("distinguishes applied, uncertain and cancelled application records, including on mobile", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: /개발 검증 예제 example/ }).click();
  const panel = page.getByRole("region", { name: "개발·검증 기록", exact: true });
  await page.getByRole("button", { name: /반영 완료 기록/ }).click();
  await expect(page.locator(".detail-top .status-succeeded")).toBeVisible();
  await expect(panel).toContainText("개발용 브랜치에 반영됨");
  await expect(page.getByRole("button", { name: "상태 확인", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "작업 재개", exact: true })).toHaveCount(0);
  await panel.getByText("반영 버전 보기", { exact: true }).click();
  await expect(panel).toContainText("e".repeat(40));
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: /반영 확인 대기 기록/ }).click();
  await expect(page.locator(".detail-top .status-blocked")).toBeVisible();
  await expect(panel).toContainText("반영 완료 확인 필요");
  await expect(page.getByRole("button", { name: "상태 확인", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "작업 재개", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: /반영 후 취소 기록/ }).click();
  await expect(page.locator(".detail-top .status-cancelled")).toBeVisible();
  await expect(panel).toContainText("개발용 브랜치에 반영됨");
  await expect(panel).toContainText("되돌리지 않습니다");
  await expect(page.getByRole("button", { name: "작업 재개", exact: true })).toBeDisabled();
});

test("does not describe a cancelled development preparation as still in progress", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: /개발 검증 예제 example/ }).click();
  await page.getByRole("button", { name: /준비 중단 기록/ }).click();
  await expect(page.locator(".detail-top .status-cancelled")).toBeVisible();
  const evidence = page.getByRole("region", { name: "개발·검증 기록", exact: true });
  await expect(evidence).toContainText("저장된 개발 회차가 없습니다.");
  await expect(evidence).not.toContainText("준비하고 있습니다");
});

test("shows dated planning evidence and keeps a failed collection separate from historical success", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: /관측 계획 예제 example/ }).click();
  await page.getByRole("button", { name: /관측을 확인한 계획 기록/ }).click();
  const evidence = page.getByRole("region", { name: "계획에 사용한 관측", exact: true });
  await expect(evidence).toContainText("당시 기록이며 현재 상태는 서비스 화면에서 확인하세요");
  await expect(evidence).toContainText("서비스 1 / 1개");
  await evidence.locator("summary").click();
  await expect(evidence).toContainText("관측 실패");
  await expect(evidence).toContainText("당시 최신 수집");
  await expect(evidence).toContainText("과거 수집 성공 · 최신 상태를 대신하지 않습니다");
  await expect(evidence).toContainText("<script>");
  expect(await page.evaluate(() => "planningUnwanted" in window)).toBe(false);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: /관측 계획 예제 example/ }).click();
  await expect(evidence).toContainText("서비스 1 / 1개");
});

test("releases cancelled planned work once after a lost response and preserves both linked records", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: /취소 재허용 예제 example/ }).click();
  await page.getByRole("button", { name: /취소 기록을 이어받을 개선 작업/ }).click();
  await expect(page.locator(".detail-top .status-cancelled")).toBeVisible();
  const commands: unknown[] = [];
  let holdRefresh = true;
  await page.route("**/tasks/*/release", async (route) => {
    commands.push(route.request().postDataJSON());
    const result = await route.fetch();
    if (commands.length === 1) {
      expect(result.status()).toBe(201);
      await route.abort("failed");
    } else {
      expect(result.status()).toBe(200);
      holdRefresh = false;
      await route.fulfill({ response: result });
    }
  });
  // Keep the original detail visible while retrying an uncertain response.
  let blockedRefreshes = 0;
  await page.route("**/projects/*/tasks", async (route) => {
    if (holdRefresh && route.request().method() === "GET") {
      blockedRefreshes++;
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "취소한 작업 다시 허용", exact: true }).click();
  await expect(page.locator(".task-detail [role=alert]")).toContainText(
    "서버에 연결하지 못했습니다",
  );
  // Exercise a polling turn before retrying; a refresh must not consume the lost-response scenario.
  const beforeRetry = blockedRefreshes;
  await expect.poll(() => blockedRefreshes).toBeGreaterThan(beforeRetry);
  await page.getByRole("button", { name: "취소한 작업 다시 허용", exact: true }).click();
  await expect(page.locator(".detail-top .status-queued")).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  await expect(page.getByLabel("자동 복구 정책", { exact: true })).toContainText("재시도 0 / 3회");
  await expect(page.locator(".task-list .task-row")).toHaveCount(2);
  await page.getByRole("button", { name: "이전 취소 작업 보기", exact: true }).click();
  await expect(page.locator(".detail-top .status-cancelled")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "취소한 작업 다시 허용", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "다시 허용한 작업 보기", exact: true }).click();
  await expect(page.locator(".detail-top .status-queued")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: /취소 재허용 예제 example/ }).click();
  await expect(page.locator(".task-list .task-row")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "이전 취소 작업 보기", exact: true }),
  ).toBeVisible();
});

test("rechecks planned work after resume and distinguishes excluded work from retained work", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: /범위 재검사 예제 example/ }).click();
  const panel = page.getByRole("region", { name: "프로젝트 목표", exact: true });
  await openSection(page, "목표");
  await panel.getByRole("button", { name: "목표 일시정지" }).click();
  await expect(panel).toContainText("일시정지 · 버전 2");
  await panel.getByRole("button", { name: "목표 재개" }).click();
  await expect(panel).toContainText("활성 · 버전 3");
  await openSection(page, "작업");
  await page.getByRole("button", { name: /예제 코드 개선 작업/ }).click();
  const review = page.getByLabel("목표 범위 재검사", { exact: true });
  await expect(review).toContainText("변경된 목표에서도 허용된 작업입니다.");
  await expect(review).toContainText("1 → 3");
  await openSection(page, "목표");
  await panel.getByRole("button", { name: "목표 수정" }).click();
  await panel.getByText("허용 범위와 실행 예산", { exact: true }).click();
  await page.getByLabel("허용 경로", { exact: true }).fill("tests");
  await panel.getByRole("button", { name: "목표 저장", exact: true }).click();
  await expect(panel).toContainText("활성 · 버전 4");
  await openSection(page, "작업");
  await expect(page.locator(".detail-top .status-cancelled")).toBeVisible();
  await expect(review).toContainText("허용 범위를 벗어나 제외한 작업");
  await expect(review).toContainText("3 → 4");
  await expect(page.locator(".task-detail .empty-list")).toContainText(
    "자동으로 시작하지 않습니다.",
  );
  await expect(page.getByRole("button", { name: "작업 재개", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: /예제 테스트 추가 작업/ }).click();
  await expect(page.locator(".detail-top .status-queued")).toBeVisible();
  await expect(review).toContainText("변경된 목표에서도 허용된 작업입니다.");
  await page.reload();
  await page.getByRole("button", { name: /범위 재검사 예제 example/ }).click();
  await openSection(page, "작업");
  await page.getByRole("button", { name: /예제 코드 개선 작업/ }).click();
  await expect(review).toContainText("허용 범위를 벗어나 제외한 작업");
});

test("removes period budget waits immediately and saves unlimited goal budgets", async ({
  page,
}) => {
  await login(page);
  await createProject(page, "예산 제한 해제 예제");
  await openSection(page, "설정");
  const panel = page.getByRole("region", { name: "실행 예산", exact: true });
  await panel.locator("summary").click();
  await openSection(page, "설정");
  await panel.getByRole("button", { name: "프로젝트 예산 수정" }).click();
  await panel.getByLabel("호출 상한(회)", { exact: true }).fill("1");
  await panel.getByRole("button", { name: "예산 저장" }).click();
  await createTask(page, "제한 해제 전 첫 분석");
  await expect(page.locator(".detail-top .status-succeeded")).toBeVisible();
  await createTask(page, "제한 해제 뒤 이어갈 분석");
  await expect(page.getByLabel("기간 예산 대기", { exact: true })).toBeVisible();
  await openSection(page, "설정");
  await panel.getByRole("button", { name: "프로젝트 예산 수정" }).click();
  await panel.getByLabel("프로젝트 예산 제한 없음", { exact: true }).check();
  await expect(panel.getByLabel("호출 상한(회)", { exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "예산 저장" }).click();
  await openSection(page, "작업");
  await expect(page.locator(".detail-top .status-succeeded")).toBeVisible();
  await openSection(page, "설정");
  await expect(panel).toContainText("프로젝트 설정: 자체 예산 제한 없음");
  await expect(panel).toContainText("허용한 호출 2 / 제한 없음");
  const goals = page.getByRole("region", { name: "프로젝트 목표", exact: true });
  await openSection(page, "목표");
  await goals.getByRole("button", { name: "목표 등록 +" }).click();
  await page
    .getByRole("textbox", { name: "프로젝트 목표", exact: true })
    .fill("예산 제한 없이 코드 점검");
  await page.getByLabel("완료·평가 기준", { exact: true }).fill("검증 결과를 기록한다");
  await goals.getByText("허용 범위와 실행 예산", { exact: true }).click();
  await page.getByLabel("목표 예산 제한 없음", { exact: true }).check();
  await expect(page.getByLabel("기간 내 최대 호출", { exact: true })).toBeDisabled();
  await goals.getByRole("button", { name: "목표 저장", exact: true }).click();
  await expect(goals.locator(".goal-form")).toHaveCount(0);
  await goals.getByRole("button", { name: "목표 수정" }).click();
  await goals.getByText("허용 범위와 실행 예산", { exact: true }).click();
  await expect(page.getByLabel("목표 예산 제한 없음", { exact: true })).toBeChecked();
});

test("enforces project call budgets, keeps current usage after policy edits, and can cancel an unstarted waiting task", async ({
  page,
}, testInfo) => {
  await login(page);
  await createProject(page, "예산 관리 예제");
  await openSection(page, "설정");
  const panel = page.getByRole("region", { name: "실행 예산", exact: true });
  await panel.locator("summary").click();
  await openSection(page, "설정");
  await panel.getByRole("button", { name: "프로젝트 예산 수정" }).click();
  await panel.getByLabel("예산 기간(분)", { exact: true }).fill("10");
  await panel.getByLabel("호출 상한(회)", { exact: true }).fill("1");
  await panel.getByLabel("실행 시간 상한(초)", { exact: true }).fill("60");
  await panel.getByRole("button", { name: "예산 저장" }).click();
  await expect(panel.getByRole("form", { name: "프로젝트 예산 설정" })).toHaveCount(0);
  await createTask(page, "예산 범위 내 첫 분석");
  await expect(page.locator(".detail-top .status-succeeded")).toBeVisible();
  await openSection(page, "설정");
  await expect(panel).toContainText("허용한 호출 1 / 1회");
  await createTask(page, "다음 기간까지 기다리는 분석");
  await expect(page.getByLabel("기간 예산 대기", { exact: true })).toContainText(
    "프로젝트 실행 예산 대기",
  );
  await expect(page.getByRole("button", { name: "작업 재개", exact: true })).toBeDisabled();
  await openSection(page, "설정");
  await panel.getByRole("button", { name: "프로젝트 예산 수정" }).click();
  await panel.getByLabel("호출 상한(회)", { exact: true }).fill("2");
  await panel.getByRole("button", { name: "예산 저장" }).click();
  await expect(panel).toContainText("프로젝트 설정: 10분마다 최대 2회");
  await openSection(page, "설정");
  await expect(panel).toContainText("허용한 호출 1 / 1회");
  await page.reload();
  await page.getByRole("button", { name: /예산 관리 예제 example/ }).click();
  await page.getByRole("button", { name: /다음 기간까지 기다리는 분석/ }).click();
  await expect(page.getByLabel("기간 예산 대기", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await openSection(page, "설정");
  await panel.locator("summary").click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("budget-wait-mobile.png"), fullPage: true });
  await openSection(page, "작업");
  await page.getByRole("button", { name: "작업 취소", exact: true }).click();
  await expect(page.locator(".detail-top .status-cancelled")).toBeVisible();
});

test("registers projects and tasks, escapes model output, and separates waiting, failed and stale service observations", async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await login(page);
  await createProject(page, "언어 공부 앱");
  await createTask(page, "여러 시스템의 복잡한 원인과 코드 구조를 분석해 줘.");
  await page.locator(".run-technical > summary").click();
  await expect(page.locator(".run-technical .run-facts")).toContainText("xhigh");
  await expect(page.locator(".run-technical .run-facts")).toContainText(
    "여러 시스템의 복잡한 원인 분석",
  );
  await expect(page.locator(".run-record > .analysis-result")).toContainText("<script>");
  await expect(page.locator(".detail-top .status-succeeded")).toBeVisible();
  expect(await page.evaluate(() => "unwanted" in window)).toBe(false);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator(".run-record > .analysis-result")).toBeVisible();
  expect(errors).toEqual([]);
  await page.getByRole("button", { name: /관측 예제/ }).click();
  await openSection(page, "설정");
  await expect(page.locator(".services-panel")).toHaveCount(1);
  await expect(page.locator(".service-state")).toHaveText("정상 대기");
  await expect(page.locator(".service-evidence")).not.toHaveClass(/historical/);
  await request.post("http://127.0.0.1:4321/fixture/failure");
  await expect(page.locator(".service-state")).toHaveText("관측 실패");
  await expect(page.locator(".service-evidence.historical")).toContainText("이전 수집 기록");
  await expect(page.locator(".service-summary")).toContainText("새 학습 기록");
  await request.post("http://127.0.0.1:4321/fixture/stale");
  await expect(page.locator(".service-state")).toHaveText("오래된 정보");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("services-mobile.png"),
    fullPage: true,
  });
  await request.post("http://127.0.0.1:4321/fixture/waiting");
  await expect(page.locator(".service-state")).toHaveText("정상 대기");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: testInfo.outputPath("services-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: /언어 공부 앱 example/ }).click();
  await expect(page.locator(".services-panel")).toHaveCount(0);
  await page.getByRole("button", { name: /관측 예제/ }).click();
  await openSection(page, "설정");
  await expect(page.locator(".services-panel")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("retries a failed task, cancels active analysis, and waits for automatic account recovery", async ({
  page,
}, testInfo) => {
  await login(page);
  await createProject(page, "실행 상태 확인");
  await createTask(page, "재개 흐름을 확인해 줘.");
  await expect(page.locator(".detail-top .status-failed")).toBeVisible();
  await page.getByRole("button", { name: "작업 재개", exact: true }).click();
  await expect(page.locator(".run-record > .analysis-result")).toBeVisible();
  await expect(page.locator(".attempt")).toHaveCount(2);
  await page.locator(".attempt").last().click();
  await expect(page.getByText("이전 실행 기록입니다.", { exact: false })).toBeVisible();
  await createTask(page, "오래 분석하는 작업입니다.");
  await expect(page.locator(".detail-top .status-running")).toBeVisible();
  await page.getByRole("button", { name: "작업 취소", exact: true }).click();
  await expect(page.locator(".detail-top .status-cancelled")).toBeVisible();
  await createTask(page, "한도 응답을 확인해 줘.");
  await expect(page.locator(".detail-top .status-waiting_capacity")).toBeVisible();
  await expect(page.locator(".execution-bar")).toContainText("계정 사용량 제한");
  await expect(page.getByLabel("계정 사용량 확인")).toContainText("계정 확인 0 / 3회");
  await expect(page.getByLabel("계정 사용량 확인")).toContainText("다음 확인 가능 시각");
  await expect(page.locator(".execution-bar")).toContainText("제공자 재시도 시각 미제공");
  await page.screenshot({
    path: testInfo.outputPath("capacity-wait.png"),
    fullPage: true,
  });
  await createTask(page, "회복 확인용 새 작업입니다.");
  await expect(page.locator(".detail-top .status-queued")).toBeVisible();
  await expect(page.getByRole("button", { name: "작업 재개", exact: true })).toBeDisabled();
  await expect(page.locator(".detail-top .status-succeeded")).toBeVisible();
  await expect(page.locator(".execution-bar")).not.toContainText("계정 사용량 제한");
});

test("keeps last records on disconnect and returns to login after session expiry and logout", async ({
  page,
  context,
}) => {
  await login(page);
  await createProject(page, "연결 상태 확인");
  await context.setOffline(true);
  await expect(page.getByText("서버 연결 확인 필요", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "연결 상태 확인", exact: true })).toBeVisible();
  await expect(page.locator(".connection")).toContainText("마지막 확인");
  await context.setOffline(false);
  await expect(page.getByText("서버 연결됨", { exact: false })).toBeVisible();
  await context.clearCookies();
  await expect(page.getByRole("heading", { name: "로그인", exact: true })).toBeVisible();
  await login(page);
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page.getByRole("heading", { name: "로그인", exact: true })).toBeVisible();
});

test("reuses the task request key when the server accepted a write but its response was lost", async ({
  page,
}) => {
  await login(page);
  await createProject(page, "중복 요청 확인");
  const keys: string[] = [];
  await page.route("**/projects/*/tasks", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().postDataJSON().requestKey);
    if (keys.length === 1) {
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.locator(".analysis-composer > summary").click();
  await page
    .getByLabel("분석 작업 등록", { exact: true })
    .fill("응답 유실 뒤에도 한 번만 등록해야 합니다.");
  await page.getByRole("button", { name: "분석 요청", exact: true }).click();
  await expect(page.locator(".task-composer .error-text")).toBeVisible();
  await page.getByRole("button", { name: "분석 요청", exact: true }).click();
  await expect(page.locator(".task-composer .error-text")).toHaveCount(0);
  await expect(page.locator(".task-row")).toHaveCount(1);
  await expect(page.locator(".attempt")).toHaveCount(1);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});

test("shows an automatic retry reservation and its new attempt without a resume click", async ({
  page,
}, testInfo) => {
  await login(page);
  await createProject(page, "자동 복구 예제");
  await createTask(page, "자동재시도 예제를 분석해 줘.");
  const policy = page.getByLabel("자동 복구 정책");
  await expect(policy).toContainText("다음 시도 가능 시각");
  await expect(policy).toContainText("재시도 0 / 3회");
  await page.screenshot({
    path: testInfo.outputPath("automatic-retry.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("automatic-retry-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator(".detail-top .status-succeeded")).toBeVisible({
    timeout: 12000,
  });
  await expect(policy).toContainText("재시도 1 / 3회");
  await expect(policy).not.toContainText("다음 시도 가능 시각");
  await expect(page.locator(".attempt")).toHaveCount(2);
});

test("shows sequential analysis steps and effort changes in one execution attempt", async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  await login(page);
  await createProject(page, "단계별 분석 예제");
  await createTask(page, "다단계 보안 검토");
  await expect(page.locator(".detail-top .status-succeeded")).toBeVisible();
  await expect(page.locator(".attempts .attempt")).toHaveCount(1);
  const history = page.getByRole("region", { name: "단계별 분석 기록" });
  await expect(history.locator("details")).toHaveCount(3);
  await expect(history.locator("summary").nth(0)).toContainText("high");
  await expect(history.locator("summary").nth(1)).toContainText("xhigh");
  await expect(history.locator("summary").nth(2)).toContainText("medium");
  await history.locator("summary").nth(0).click();
  await expect(history).toContainText("단계 1의 부분 분석입니다.");
  await expect(history).toContainText("추가 원인 확인");
  await expect(history).toContainText("제공된 토큰");
  await page.screenshot({
    path: testInfo.outputPath("workflow-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("workflow-mobile.png"),
    fullPage: true,
  });
});

test("manages versioned goals, preserves a lost-response request key and shows previous definitions", async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  await login(page);
  await createProject(page, "목표 관리 예제");
  const panel = page.getByRole("region", {
    name: "프로젝트 목표",
    exact: true,
  });
  await openSection(page, "목표");
  await panel.getByRole("button", { name: "목표 등록 +" }).click();
  await page
    .getByRole("textbox", { name: "프로젝트 목표", exact: true })
    .fill("복습 화면을 완성한다");
  await page.getByLabel("완료·평가 기준", { exact: true }).fill("복습 결과가 저장된다");
  const keys: string[] = [];
  await page.route("**/projects/*/goals", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    keys.push(route.request().postDataJSON().requestKey);
    if (keys.length === 1) {
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await panel.getByRole("button", { name: "목표 저장", exact: true }).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await panel.getByRole("button", { name: "목표 저장", exact: true }).click();
  await expect(panel.locator(".goal-form")).toHaveCount(0);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  await expect(panel.locator(".goal-card")).toHaveCount(1);
  await expect(panel).toContainText("활성 · 버전 1");
  await panel.getByRole("button", { name: "목표 일시정지" }).click();
  await expect(panel).toContainText("일시정지 · 버전 2");
  await panel.getByRole("button", { name: "목표 재개" }).click();
  await expect(panel).toContainText("활성 · 버전 3");
  await panel.getByRole("button", { name: "목표 수정" }).click();
  await page.getByLabel("완료·평가 기준", { exact: true }).fill("복습 결과와 날짜가 저장된다");
  await panel.getByRole("button", { name: "목표 저장", exact: true }).click();
  await expect(panel).toContainText("활성 · 버전 4");
  await panel.getByRole("button", { name: "변경 이력" }).click();
  await expect(panel.locator(".goal-history details")).toHaveCount(4);
  await panel.locator(".goal-history summary").last().click();
  await expect(panel.locator(".goal-history")).toContainText("완료 기준: 복습 결과가 저장된다");
  await page.screenshot({
    path: testInfo.outputPath("goals-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("goals-mobile.png"),
    fullPage: true,
  });
  await page.reload();
  await openSection(page, "목표");
  await expect(panel).toContainText("복습 결과와 날짜가 저장된다");
});

test("opens the project overview, preserves navigation and marks retained data when its request fails", async ({
  page,
}, testInfo) => {
  await login(page);
  await expect(page.getByRole("heading", { name: "전체 현황", exact: true })).toBeVisible();
  const overview = page.getByRole("region", { name: "프로젝트 전체 현황", exact: true });
  await expect(overview.locator(".overview-project").first()).toBeVisible();
  await createProject(page, "전체 현황 탐색 예제");
  await createTask(page, "전체 현황에서 결과 확인");
  await expect(page.locator(".detail-top .status-succeeded")).toBeVisible();
  await page.getByRole("button", { name: "전체 현황", exact: true }).click();
  const card = overview
    .locator(".overview-project")
    .filter({ has: page.getByRole("heading", { name: "전체 현황 탐색 예제", exact: true }) });
  await expect(card).toContainText("실행 중인 작업 없음");
  await expect(card).toContainText("완료");
  await card.getByRole("button", { name: "전체 현황에서 결과 확인", exact: true }).click();
  await expect(page.locator("#detail-heading")).toHaveText("전체 현황에서 결과 확인");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "전체 현황 탐색 예제", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(overview).toBeVisible();
  await expect(card).toBeVisible();
  await page.route("**/projects/overview?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "UNAVAILABLE", message: "Unavailable" }),
    }),
  );
  await expect(overview.getByRole("alert")).toContainText("마지막으로 확인한 현황");
  await expect(card).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("overview-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("overview-mobile.png"), fullPage: true });
  await page.unroute("**/projects/overview?*");
  await overview.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(overview.getByRole("alert")).toHaveCount(0);
});

test("checks GitHub configuration explicitly and clears repository data after revoked access", async ({
  page,
}, testInfo) => {
  await login(page);
  const panel = page.getByRole("region", { name: "GitHub 저장소 연결", exact: true });
  await panel.locator("summary").click();
  await expect(panel).toContainText("서버에 GitHub App 연결 설정이 필요합니다");
  await page.route("**/integrations/github", (route) =>
    route.fulfill({ json: { configured: true } }),
  );
  await panel.getByRole("button", { name: "설정 다시 확인" }).click();
  const pages: number[] = [];
  await page.route("**/integrations/github/repositories", async (route) => {
    const current = route.request().postDataJSON().page;
    pages.push(current);
    await route.fulfill({
      json: {
        owner: "fixture-owner",
        checkedAt: "2026-11-01T00:00:00Z",
        repositories: [
          {
            id: current,
            name: `example-${current}`,
            fullName: `fixture-owner/example-${current}`,
            private: true,
            archived: false,
          },
        ],
        nextPage: current === 1 ? 2 : null,
      },
    });
  });
  await panel.getByRole("button", { name: "연결 확인 및 저장소 조회" }).click();
  await expect(panel).toContainText("fixture-owner/example-1");
  await panel.getByRole("button", { name: "다음", exact: true }).click();
  await expect(panel).toContainText("fixture-owner/example-2");
  await expect(panel).not.toContainText("fixture-owner/example-1");
  expect(pages).toEqual([1, 2]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("github-connection-mobile.png"),
    fullPage: true,
  });
  await page.unroute("**/integrations/github/repositories");
  await page.route("**/integrations/github/repositories", (route) =>
    route.fulfill({
      status: 502,
      json: { error: "GITHUB_PERMISSION", message: "Unable to read GitHub repositories" },
    }),
  );
  await panel.getByRole("button", { name: "연결 확인 및 저장소 조회" }).click();
  await expect(panel.getByRole("alert")).toContainText("접근 권한을 확인");
  await expect(panel).not.toContainText("fixture-owner/example-2");
});

// UI contract only: GitHub/import responses are synthetic. Server tests exercise
// authentication, archive preparation, durable registration and runtime activation.
test("explains unavailable imports after selecting a repository and recovers when configured", async ({
  page,
}) => {
  let enabled = false;
  let submissions = 0;
  await page.route("**/integrations/github", (route) =>
    route.fulfill({ json: { configured: true } }),
  );
  await page.route("**/integrations/github/repositories", (route) =>
    route.fulfill({
      json: {
        owner: "fixture-owner",
        checkedAt: new Date().toISOString(),
        nextPage: null,
        repositories: [
          {
            id: 78,
            name: "example",
            fullName: "fixture-owner/example",
            private: true,
            archived: false,
          },
        ],
      },
    }),
  );
  await page.route("**/integrations/github/imports", (route) => {
    if (route.request().method() === "POST") submissions++;
    return route.fulfill({ json: { enabled, profiles: enabled ? ["node"] : [], imports: [] } });
  });
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = page.getByRole("region", { name: "GitHub 저장소 연결", exact: true });
  await panel.locator("summary").click();
  await panel.getByRole("button", { name: "연결 확인 및 저장소 조회" }).click();
  const imports = panel.getByRole("region", { name: "프로젝트 가져오기", exact: true });
  await expect(imports).toContainText("가져오려면 서버에 GitHub 연결과 개발·검증 환경을 설정");
  const select = panel.getByRole("button", { name: "가져오기 선택", exact: true });
  await select.click();
  const selected = panel.getByRole("button", { name: "선택됨 · 가져오기 확인", exact: true });
  await expect(selected).toBeVisible();
  await expect(selected).toHaveAttribute("aria-controls", "repository-imports");
  expect(
    await imports.evaluate((element) => {
      const creation = document.querySelector('[aria-label="새 프로젝트 만들기"]');
      return (
        creation !== null &&
        Boolean(element.compareDocumentPosition(creation) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
    }),
  ).toBe(true);
  await expect(imports.getByRole("status")).toContainText("fixture-owner/example");
  await expect(imports.getByRole("heading")).toBeFocused();
  await expect(imports.getByRole("heading")).toBeInViewport();
  await expect(
    imports.getByRole("button", { name: "이 저장소 가져오기", exact: true }),
  ).toHaveCount(0);
  await selected.focus();
  await page.keyboard.press("Enter");
  await expect(imports.getByRole("heading")).toBeFocused();
  enabled = true;
  const refresh = imports.getByRole("button", { name: "가져오기 상태 새로고침" });
  await refresh.click();
  await expect(imports.getByLabel("가져올 프로젝트 이름")).toHaveValue("example");
  await expect(imports.getByLabel("검증 환경", { exact: true })).toHaveValue("node");
  await expect(refresh).toBeFocused();
  expect(submissions).toBe(0);
});

test("selects a repository, retries and cancels an import, then opens its ready project", async ({
  page,
}, testInfo) => {
  await login(page);
  const projectsResponse = await page.request.get("/projects");
  const project = (await projectsResponse.json()).projects[0];
  const id = "a3b0d7b5-35ac-4b12-a6b5-6b8061cb3e41";
  let job: Record<string, unknown> | undefined;
  const posts: Record<string, unknown>[] = [];
  await page.route("**/integrations/github", (route) =>
    route.fulfill({ json: { configured: true } }),
  );
  await page.route("**/integrations/github/repositories", (route) =>
    route.fulfill({
      json: {
        owner: "fixture-owner",
        checkedAt: new Date().toISOString(),
        nextPage: null,
        repositories: [
          {
            id: 78,
            name: "example",
            fullName: "fixture-owner/example",
            private: true,
            archived: false,
          },
        ],
      },
    }),
  );
  await page.route("**/integrations/github/imports", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      posts.push(body);
      job = {
        id,
        repositoryId: 78,
        name: body.name,
        profile: body.profile,
        status: "preparing",
        cancelRequestedAt: null,
        attempt: 1,
        fullName: null,
        revision: null,
        errorCode: null,
        projectId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await route.fulfill({ status: 202, json: job });
    } else
      await route.fulfill({
        json: { enabled: true, profiles: ["node"], imports: job ? [job] : [] },
      });
  });
  const actions: string[] = [];
  await page.route(`**/integrations/github/imports/${id}`, async (route) => {
    const action = route.request().postDataJSON().action;
    actions.push(action);
    job = {
      ...job,
      status: "preparing",
      cancelRequestedAt: action === "cancel" ? new Date().toISOString() : null,
      errorCode: null,
      attempt: action === "retry" ? 2 : 1,
    };
    await route.fulfill({ json: job });
  });
  await page.reload();
  const panel = page.getByRole("region", { name: "GitHub 저장소 연결", exact: true });
  await panel.locator("summary").click();
  await panel.getByRole("button", { name: "연결 확인 및 저장소 조회" }).click();
  await panel.getByRole("button", { name: "가져오기 선택", exact: true }).click();
  await expect(
    panel.getByRole("heading", { name: "프로젝트 가져오기", exact: true }),
  ).toBeFocused();
  await panel.getByLabel("가져올 프로젝트 이름").fill("내 학습 앱");
  await panel.getByRole("button", { name: "이 저장소 가져오기", exact: true }).click();
  await expect(panel).toContainText("소스 준비 중");
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ repositoryId: 78, name: "내 학습 앱", profile: "node" });
  expect(posts[0]!.requestKey).toMatch(/^[a-f0-9-]{36}$/);
  await panel.getByRole("button", { name: "가져오기 취소", exact: true }).click();
  await expect(panel).toContainText("취소 처리 중");
  await page.screenshot({
    path: testInfo.outputPath("github-import-cancelling.png"),
    fullPage: true,
  });
  await expect(panel.getByRole("button", { name: "다시 가져오기", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "가져오기 취소", exact: true })).toHaveCount(0);
  job = { ...job, status: "cancelled" };
  await panel.getByRole("button", { name: "가져오기 상태 새로고침" }).click();
  await expect(panel).toContainText("취소됨");
  await panel.getByRole("button", { name: "다시 가져오기", exact: true }).click();
  await expect(panel).toContainText("소스 준비 중");
  expect(actions).toEqual(["cancel", "retry"]);
  job = { ...job, status: "failed", errorCode: "GITHUB_PERMISSION" };
  await panel.getByRole("button", { name: "가져오기 상태 새로고침" }).click();
  await expect(panel).toContainText("접근 권한을 확인");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("github-import-mobile.png"), fullPage: true });
  job = {
    ...job,
    status: "ready",
    errorCode: null,
    projectId: project.id,
    fullName: "fixture-owner/example",
    revision: "a".repeat(40),
  };
  await panel.getByRole("button", { name: "가져오기 상태 새로고침" }).click();
  await expect(panel).toContainText("프로젝트 준비 완료");
  await panel.getByRole("button", { name: "프로젝트 열기", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#project/${project.id}$`));
  await expect(page.getByRole("heading", { name: project.name, exact: true })).toBeVisible();
});

test("explains why AI execution waits while repository source preparation owns capacity", async ({
  page,
}) => {
  await login(page);
  await page.route("**/execution", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      json: { ...data, state: "idle", reason: "repository_import", runId: null, taskId: null },
    });
  });
  await page.reload();
  const status = page.getByRole("region", { name: "자동 실행 상태" });
  await expect(status).toContainText("저장소 준비 대기");
  await expect(status).toContainText("저장소 소스 준비가 끝나면 AI 작업을 이어갑니다.");
});

test("filters work history without losing the inspected record when a new plan arrives", async ({
  page,
}, testInfo) => {
  await login(page);
  await page.getByRole("button", { name: /개발 검증 예제 example/ }).click();
  await expect(page.locator(".task-row").first()).toBeVisible();
  const initialCount = await page.locator(".task-row").count();
  const originalTitle = await page.locator("#detail-heading").innerText();
  const totals = await page.locator(".activity-totals dd").allTextContents();
  await page.route("**/projects/*/tasks", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.tasks[0].instruction += "\n" + "검증 기준과 상세 작업 지시입니다. ".repeat(50);
    body.tasks.unshift({
      ...body.tasks[0],
      id: "f8c6f684-a7d5-45f8-9a46-f18685957fa1",
      kind: "planning",
      instruction: "새로 추가된 계획 점검",
    });
    await route.fulfill({ response, json: body });
  });
  await expect(page.locator(".task-row")).toHaveCount(initialCount + 1);
  await expect(page.locator("#detail-heading")).toHaveText(originalTitle);
  await expect(page.locator(".activity-totals dd")).toHaveText(totals);
  const instruction = page.locator(".task-instruction");
  await expect(instruction.locator("pre")).toBeHidden();
  await instruction.locator("summary").click();
  await expect(instruction.locator("pre")).toContainText("검증 기준과 상세 작업 지시입니다.");
  await instruction.locator("summary").click();
  const filters = page.getByRole("group", { name: "작업 종류 필터" });
  await filters.getByRole("button", { name: "계획", exact: true }).click();
  await expect(page.locator(".task-row")).toHaveCount(1);
  await expect(page.locator(".task-row")).toContainText("새로 추가된 계획 점검");
  await expect(page.locator(".filter-note")).toBeVisible();
  await page.getByRole("searchbox", { name: "작업 기록 검색" }).fill("찾을 수 없는 작업");
  await expect(page.locator(".task-row")).toHaveCount(0);
  await page.getByRole("button", { name: "필터 초기화", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "작업 기록 검색" })).toBeFocused();
  await expect(page.locator(".task-row")).toHaveCount(initialCount + 1);
  await filters.getByRole("button", { name: "실제 작업", exact: true }).click();
  await expect(page.locator(".task-row")).toHaveCount(initialCount);
  await page.getByRole("searchbox", { name: "작업 기록 검색" }).fill("준비 중단");
  await expect(page.locator(".task-row")).toHaveCount(1);
  await page.locator(".task-row").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#detail-heading")).toBeFocused();
  const flow = page.getByRole("region", { name: "개발 작업 흐름" });
  await expect(flow).toContainText("마지막 기록");
  await expect(flow.locator('[aria-current="step"]')).toHaveText("준비");
  const technical = page.locator(".run-technical");
  await expect(technical.locator("dl")).toBeHidden();
  await technical.locator("summary").click();
  await expect(technical.locator("dl")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("work-history-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator(".task-row").click();
  await expect(page.locator("#detail-heading")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator(".task-status-update")).toHaveCSS("animation-name", "none");
  await page.screenshot({ path: testInfo.outputPath("work-history-mobile.png"), fullPage: true });
});

test("opens current work from an older record and removes the live shortcut on disconnect", async ({
  page,
}, testInfo) => {
  await login(page);
  await createProject(page, "현재 작업 이동 예제");
  await createTask(page, "이전에 완료한 분석");
  await expect(page.locator(".detail-top .status-succeeded")).toBeVisible();
  await createTask(page, "오래 걸리는 현재 분석");
  const current = page.getByRole("region", { name: "이 프로젝트의 현재 작업" });
  await expect(current).toContainText("오래 걸리는 현재 분석");
  await page.locator(".task-row").filter({ hasText: "이전에 완료한 분석" }).click();
  await expect(page.locator("#detail-heading")).toHaveText("이전에 완료한 분석");
  await current.getByRole("button").click();
  await expect(page.locator("#detail-heading")).toHaveText("오래 걸리는 현재 분석");
  await expect(page.locator("#detail-heading")).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("current-work-desktop.png"), fullPage: true });
  await page.route("**/execution", (route) => route.abort("failed"));
  await expect(page.locator(".connection")).toContainText("서버 연결 확인 필요");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".connection small")).toBeVisible();
  await expect(page.locator(".connection small")).toContainText("마지막 확인");
  await expect(current).toHaveCount(0);
  await page.unroute("**/execution");
  await page.getByRole("button", { name: "작업 취소", exact: true }).click();
  await expect(page.locator(".detail-top .status-cancelled")).toBeVisible();
});

test("separates work, goals and settings while retaining drafts and showing paused goals", async ({
  page,
}, testInfo) => {
  // Other fixture projects have unresolved runs. Control the server state separately
  // from the real goal CRUD so this scenario covers both idle and globally held states.
  let serverHeld = false;
  await page.route("**/execution", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        state: serverHeld ? "held" : "idle",
        reason: serverHeld ? "change_application_pending" : "development_pending",
        taskId: null,
        runId: null,
      },
    });
  });
  await login(page);
  await createProject(page, "메뉴와 상태 확인 예제");
  const activity = page.getByRole("region", { name: "프로젝트 작업 현황" });
  await expect(activity).toContainText("지금은 실행 중인 작업이 없어요");
  await expect(page.getByRole("region", { name: "프로젝트 목표", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "프로젝트 공개 설정", exact: true })).toHaveCount(
    0,
  );
  await page.locator(".analysis-composer > summary").click();
  await page.getByLabel("분석 작업 등록", { exact: true }).fill("아직 보내지 않은 분석 지시");
  await activity.getByRole("button", { name: "목표 확인", exact: true }).click();
  const menu = page.getByRole("navigation", { name: "프로젝트 메뉴" });
  await expect(menu.getByRole("button", { name: "목표", exact: true })).toBeFocused();
  const goals = page.getByRole("region", { name: "프로젝트 목표", exact: true });
  await goals.getByRole("button", { name: "목표 등록 +", exact: true }).click();
  await page
    .getByRole("textbox", { name: "프로젝트 목표", exact: true })
    .fill("다음 배포를 준비한다");
  await page.getByLabel("완료·평가 기준", { exact: true }).fill("전체 테스트가 통과한다");
  await goals.getByRole("button", { name: "목표 저장", exact: true }).click();
  const criteria = goals.locator(".goal-criteria");
  await expect(criteria.locator("p")).toBeHidden();
  await criteria.locator("summary").click();
  await expect(criteria.locator("p")).toHaveText("전체 테스트가 통과한다");
  await criteria.locator("summary").click();
  await goals.getByRole("button", { name: "목표 일시정지", exact: true }).click();
  await expect(goals).toContainText("일시정지 · 버전 2");
  await openSection(page, "작업");
  await expect(activity).toContainText("목표가 일시정지돼 있어요");
  await page.route("**/projects/*/goals", (route) => route.abort("failed"));
  await expect(activity).toContainText("목표 상태는 아직 확인되지 않았습니다");
  await expect(activity).not.toContainText("목표의 실행 조건을 기다리고 있습니다");
  await expect(activity.locator(".activity-totals dd")).toHaveText(["0", "0", "0"]);
  await page.unroute("**/projects/*/goals");
  await expect(activity).toContainText("목표가 일시정지돼 있어요");
  await expect(page.getByLabel("분석 작업 등록", { exact: true })).toHaveValue(
    "아직 보내지 않은 분석 지시",
  );
  await page.locator(".analysis-composer > summary").click();
  await page.screenshot({
    path: testInfo.outputPath("workspace-paused-desktop.png"),
    fullPage: true,
  });
  await openSection(page, "설정");
  const publication = page.getByRole("region", { name: "프로젝트 공개 설정", exact: true });
  await publication.locator("summary").click();
  await publication.getByLabel("공개용 이름", { exact: true }).fill("저장하지 않은 공개 이름");
  await openSection(page, "작업");
  await openSection(page, "설정");
  await expect(publication.getByLabel("공개용 이름", { exact: true })).toHaveValue(
    "저장하지 않은 공개 이름",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await openSection(page, "작업");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("workspace-paused-mobile.png"),
    fullPage: true,
  });
  await createProject(page, "목표 없는 다른 프로젝트");
  await expect(activity).toContainText("목표를 등록하면");
  await expect(activity).not.toContainText("일시정지");
  serverHeld = true;
  await expect(activity).toContainText("실행 조건을 확인해야 해요");
});

test("keeps a completed result in the first desktop viewport and discloses execution details", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The page must keep room for the result when the server has no blocking notice.
  await page.route("**/execution", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), state: "idle", taskId: null, runId: null, reason: null },
    });
  });
  // The historical application fixture has no result text. Include a typical
  // outcome to exercise the reading layout, without changing its saved evidence.
  await page.route("**/runs/*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        result:
          "CSV 입력의 잘못된 형식을 처리하도록 수정했습니다. 테스트와 코드 검토를 마쳤으며 변경은 개발용 브랜치에 반영됐습니다.",
      },
    });
  });
  await login(page);
  await page.getByRole("button", { name: /개발 검증 예제 example/ }).click();
  await page.getByRole("button", { name: /반영 완료 기록/ }).click();
  await expect(page.locator(".detail-top .status-succeeded")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  const result = page.locator(".run-record > .analysis-result");
  await expect(result).toBeInViewport({ ratio: 1 });
  const metadata = page.locator(".run-metadata");
  await expect(metadata.locator("dl")).toBeHidden();
  await metadata.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(metadata.locator("dl")).toBeVisible();
  await expect(metadata.locator("dl")).toContainText("최근 활동 기록");
  await page.keyboard.press("Enter");
  await expect(metadata.locator("dl")).toBeHidden();
  const server = page.getByRole("region", { name: "자동 실행 상태" });
  await expect(server.locator("details > p")).toBeHidden();
  await server.locator("summary").click();
  await expect(server.locator("details > p")).toBeVisible();
  await server.locator("summary").click();
  await page.screenshot({ path: testInfo.outputPath("outcome-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /반영 완료 기록/ }).click();
  await expect(page.locator("#detail-heading")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("reopens a changed server warning and keeps capacity instructions readable", async ({
  page,
}) => {
  let reason = "change_application_pending";
  let capacity = false;
  await page.route("**/execution", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), state: "held", reason, runId: null, taskId: null },
    });
  });
  await page.route("**/execution/provider-gate", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        version: capacity ? 2 : 1,
        blocked: capacity,
        reason: capacity ? "capacity" : null,
        retryAt: null,
        capacityState: capacity
          ? {
              policy: {
                version: 1,
                initialDelayMs: 1000,
                maxDelayMs: 10000,
                jitterRatio: 0,
                maxChecks: 3,
              },
              checks: 1,
              nextCheckAt: "2026-01-01T00:00:00.000Z",
              decisionVersion: 1,
              reason: "waiting",
            }
          : null,
      },
    });
  });
  await login(page);
  const server = page.getByRole("region", { name: "자동 실행 상태" });
  const disclosure = server.locator("details");
  await expect(disclosure).toHaveAttribute("open", "");
  await server.locator("summary").click();
  await expect(disclosure).not.toHaveAttribute("open", "");
  const previousCheck = await server.locator("details > small").textContent();
  await expect(server.locator("details > small")).not.toHaveText(previousCheck!);
  await expect(disclosure).not.toHaveAttribute("open", "");
  reason = "development_pending";
  await expect(server).toContainText("개발 실행 연결 대기");
  await expect(disclosure).toHaveAttribute("open", "");
  await expect(server.locator("summary")).toBeFocused();
  await server.locator("summary").click();
  capacity = true;
  await expect(disclosure).toHaveAttribute("open", "");
  await expect(server.locator("summary")).toBeFocused();
  const summary = server.locator(".capacity-summary");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("계정 확인 1 / 3회");
  const first = await summary.locator("strong").boundingBox();
  const next = await summary.locator("span").first().boundingBox();
  expect(next!.y).toBeGreaterThanOrEqual(first!.y + first!.height);
});
