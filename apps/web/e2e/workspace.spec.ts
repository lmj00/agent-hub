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
  const back = page.getByRole("button", { name: "작업 목록", exact: true });
  if (await back.isVisible()) await back.click();
  const composer = page.locator(".analysis-composer");
  if (!(await composer.evaluate((element) => (element as HTMLDetailsElement).open)))
    await composer.locator("summary").click();
  await page.getByLabel("분석 작업 등록", { exact: true }).fill(instruction);
  await page.getByRole("button", { name: "분석 요청", exact: true }).click();
  await expect(page.locator("#detail-heading")).toHaveText(instruction);
}
async function openTask(page: Page, name: RegExp, view?: "변경·검증" | "판단 근거" | "실행 기록") {
  const back = page.getByRole("button", { name: "작업 목록", exact: true });
  if (await back.isVisible()) await back.click();
  await page.getByRole("button", { name }).click();
  if (view) await page.getByRole("tab", { name: view, exact: true }).click();
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
  await openTask(page, /목표 완료 이력/, "변경·검증");
  const panel = page.getByRole("region", { name: "목표 전체 검증 기록", exact: true });
  await expect(panel).toContainText("목표 완료 기록됨");
  await expect(panel).toContainText("목표 완료와 이력을 함께 저장했습니다");
  await panel.getByText("테스트 출력 보기", { exact: true }).click();
  await expect(panel).toContainText("2 tests passed");
  await panel.getByText("검증한 코드 버전 보기", { exact: true }).click();
  await expect(panel.locator(".application-revision")).toHaveCount(2);
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
  await openTask(page, /검토만 통과한 기록/, "변경·검증");
  await expect(panel).toContainText("목표 검증 통과");
  await expect(panel).toContainText("목표 완료가 저장된 기록은 아직 없습니다");
  await expect(panel).not.toContainText("목표 완료 기록됨");
  await openTask(page, /목표 보완 검토 기록/, "변경·검증");
  await expect(panel).toContainText("목표 보완 필요");
  await expect(panel).toContainText("오류 입력 처리 확인 필요");
  await panel.getByText("테스트 출력 보기", { exact: true }).click();
  await expect(panel.locator("pre")).toContainText("<script>");
  expect(await page.evaluate(() => "goalUnwanted" in window)).toBe(false);
  await page.reload();
  await page.getByRole("button", { name: /목표 완료 검증 예제 example/ }).click();
  await openTask(page, /목표 완료 이력/, "변경·검증");
  await expect(panel).toContainText("목표 완료 기록됨");
});

test("distinguishes selected, loaded and unknown runtime skills across attempts on desktop and mobile", async ({
  page,
}, testInfo) => {
  await login(page);
  await page.getByRole("button", { name: /지침 기록 예제 example/ }).click();
  await openTask(page, /읽기 확인 기록/, "실행 기록");
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
  await openTask(page, /선택만 된 기록/, "실행 기록");
  await expect(panel).toContainText("계획 · 선택됨 · 읽기 미확인");
  await panel.getByText("1. 계획 · 선택됨 · 읽기 미확인", { exact: true }).click();
  await expect(panel).toContainText("선택 기록만 있습니다");
  await expect(panel).not.toContainText("지침 읽기 확인");
  await openTask(page, /선택 전 중단 기록/, "실행 기록");
  await expect(panel).toContainText("지침 기록 없음");
  await expect(panel).not.toContainText("이 실행에는 지침 적용을 확인할 기록이 없습니다");
  await page.reload();
  await page.getByRole("button", { name: /지침 기록 예제 example/ }).click();
  await openTask(page, /읽기 확인 기록/, "실행 기록");
  await expect(panel).toContainText("분석 · 지침 읽기 확인");
});

test("shows failed development feedback and the later verified candidate without declaring the Task complete", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: /개발 검증 예제 example/ }).click();
  await openTask(page, /계산 오류 수정 기록/, "변경·검증");
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
  await failed
    .locator("summary")
    .filter({ hasText: /^테스트 출력$/ })
    .click();
  await expect(failed.locator(".development-output")).toContainText("AssertionError");
  await expect(failed.locator(".development-output")).toContainText("<script>");
  expect(await page.evaluate(() => "developmentUnwanted" in window)).toBe(false);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: /개발 검증 예제 example/ }).click();
  await openTask(page, /계산 오류 수정 기록/, "변경·검증");
  await expect(evidence).toContainText("2 / 3회 수정");
  await expect(page.locator(".detail-top .status-blocked")).toBeVisible();
});

test("distinguishes applied, uncertain and cancelled application records, including on mobile", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: /개발 검증 예제 example/ }).click();
  const panel = page.getByRole("region", { name: "개발·검증 기록", exact: true });
  await openTask(page, /반영 완료 기록/, "변경·검증");
  await expect(page.locator(".detail-top .status-succeeded")).toBeVisible();
  await expect(panel).toContainText("개발용 브랜치에 반영됨");
  await expect(page.getByRole("button", { name: "상태 확인", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "작업 재개", exact: true })).toHaveCount(0);
  await panel.getByText("반영 버전 보기", { exact: true }).click();
  await expect(panel).toContainText("e".repeat(40));
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await openTask(page, /반영 확인 대기 기록/, "변경·검증");
  await expect(page.locator(".detail-top .status-blocked")).toBeVisible();
  await expect(panel).toContainText("반영 완료 확인 필요");
  await expect(page.getByRole("button", { name: "상태 확인", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "작업 재개", exact: true })).toBeDisabled();
  await openTask(page, /반영 후 취소 기록/, "변경·검증");
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
  await openTask(page, /준비 중단 기록/, "변경·검증");
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
  await openTask(page, /관측을 확인한 계획 기록/, "판단 근거");
  const evidence = page.getByRole("region", { name: "계획에 사용한 관측", exact: true });
  await expect(evidence).toBeHidden();
  await page.locator(".planning-context > summary").click();
  await expect(evidence).toBeVisible();
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
  await openTask(page, /관측을 확인한 계획 기록/, "판단 근거");
  await page.locator(".planning-context > summary").click();
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
  await page.locator(".task-info > summary").click();
  await page.getByLabel("다시 허용한 작업 연결", { exact: true }).locator("summary").click();
  await page.getByRole("button", { name: "이전 취소 작업 보기", exact: true }).click();
  await expect(page.locator(".detail-top .status-cancelled")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "취소한 작업 다시 허용", exact: true }),
  ).toHaveCount(0);
  await page.locator(".task-info > summary").click();
  await page.getByLabel("다시 허용한 작업 연결", { exact: true }).locator("summary").click();
  await page.getByRole("button", { name: "다시 허용한 작업 보기", exact: true }).click();
  await expect(page.locator(".detail-top .status-queued")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: /취소 재허용 예제 example/ }).click();
  await expect(page.locator(".task-list .task-row")).toHaveCount(2);
  await page
    .locator(".task-row")
    .filter({ has: page.locator(".status-queued") })
    .click();
  await page.locator(".task-info > summary").click();
  await page.getByLabel("다시 허용한 작업 연결", { exact: true }).locator("summary").click();
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
  await page.getByRole("tab", { name: "실행 기록", exact: true }).click();
  await page.locator(".run-technical > summary").click();
  await expect(page.locator(".run-technical .run-facts")).toContainText("xhigh");
  await expect(page.locator(".run-technical .run-facts")).toContainText(
    "여러 시스템의 복잡한 원인 분석",
  );
  await page.getByRole("tab", { name: "결과", exact: true }).click();
  await expect(page.locator(".run-result > .analysis-result")).toContainText("<script>");
  await expect(page.locator(".detail-top .status-succeeded")).toBeVisible();
  expect(await page.evaluate(() => "unwanted" in window)).toBe(false);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator(".run-result > .analysis-result")).toBeVisible();
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
  await expect(page.locator(".run-result > .analysis-result")).toBeVisible();
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
  await expect(page.locator(".task-info > summary")).toContainText("실행 1회");
  await expect(page.locator(".attempt")).toHaveCount(0);
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
  await expect(page.locator(".task-info > summary")).toContainText("실행 1회");
  await expect(page.locator(".attempts .attempt")).toHaveCount(0);
  await page.getByRole("tab", { name: "실행 기록", exact: true }).click();
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
  await expect(card.locator(".overview-history")).not.toHaveAttribute("open", "");
  await card.locator(".overview-history > summary").click();
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

test("shows observed project activity and stops motion for stale, stopped and unconfirmed executions", async ({
  page,
}, testInfo) => {
  await login(page);
  const original = await (await page.request.get("/projects/overview")).json();
  const item = original.projects.find(
    (entry: { project: { name: string } }) => entry.project.name === "개발 검증 예제",
  );
  const { tasks } = await (await page.request.get(`/projects/${item.project.id}/tasks`)).json();
  const task = tasks.find(
    (entry: { instruction: string }) => entry.instruction === "계산 오류 수정 기록",
  );
  const { runs } = await (await page.request.get(`/tasks/${task.id}/runs`)).json();
  const detail = await (await page.request.get(`/runs/${runs[0].id}`)).json();
  let phase = "testing";
  let planning = false;
  let stopped = false;
  let finished = false;
  let detailFailed = false;
  let overviewFailed = false;
  let terminationPending = false;
  await page.route("**/projects/overview?*", (route) =>
    overviewFailed
      ? route.fulfill({ status: 503, json: { error: "UNAVAILABLE", message: "Unavailable" } })
      : route.fulfill({
          json: {
            nextOffset: null,
            projects: [
              {
                ...item,
                project: {
                  ...item.project,
                  id: "e56fd5a7-7918-4a68-a629-046a5f87c201",
                  name: "language-lab",
                },
                runningTask: null,
                latestTask: null,
                terminationPending: false,
              },
              {
                ...item,
                activeGoals: 1,
                terminationPending,
                runningTask: {
                  id: task.id,
                  instruction: task.instruction,
                  status: "running",
                  kind: planning ? "planning" : "work",
                  createdAt: task.createdAt,
                },
              },
              {
                ...item,
                project: {
                  ...item.project,
                  id: "e56fd5a7-7918-4a68-a629-046a5f87c202",
                  name: "k8s-playground",
                },
                runningTask: null,
                latestTask: null,
                terminationPending: false,
              },
            ],
          },
        }),
  );
  await page.route(`**/runs/${runs[0].id}`, (route) =>
    detailFailed
      ? route.fulfill({ status: 503, json: { error: "UNAVAILABLE", message: "Unavailable" } })
      : route.fulfill({
          json: {
            ...detail,
            status: finished ? "succeeded" : "running",
            finishedAt: finished ? detail.finishedAt : null,
            stopRequestedAt: stopped ? new Date().toISOString() : null,
            developmentEvidence: planning ? null : { ...detail.developmentEvidence, phase },
          },
        }),
  );
  await page.reload();
  const overview = page.getByRole("region", { name: "프로젝트 전체 현황", exact: true });
  const active = overview.locator(".overview-project").first();
  await expect(active.getByRole("heading", { name: "개발 검증 예제" })).toBeVisible();
  await expect(overview.locator(".project-activity")).toHaveCount(1);
  const activity = active.locator(".project-activity");
  await expect(activity).toHaveAttribute("data-live", "true");
  await expect(activity.locator('[aria-current="step"]')).toHaveText("테스트");
  await expect(activity).toContainText("실제 테스트");
  await expect(activity.locator("time")).toHaveAttribute("datetime", detail.lastActivityAt);
  await expect(overview.getByRole("progressbar")).toHaveCount(0);
  const signal = activity.locator(".project-activity-signal");
  await expect
    .poll(() => signal.evaluate((el) => getComputedStyle(el).animationName))
    .toBe("project-working");
  await page.screenshot({
    path: testInfo.outputPath("project-activity-desktop.png"),
    fullPage: true,
  });
  const open = active.getByRole("button", { name: "개발 검증 예제 열기" });
  await open.focus();
  phase = "reviewing";
  await expect(activity.locator('[aria-current="step"]')).toHaveText("검토");
  await expect(open).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => signal.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("project-activity-mobile.png"),
    fullPage: true,
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  detailFailed = true;
  await expect(activity).toHaveAttribute("data-live", "false");
  await expect(activity).toContainText("현재 활동 확인 필요");
  await expect(activity).toContainText("연결 끊김 · 마지막 기록");
  await expect.poll(() => signal.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  detailFailed = false;
  planning = true;
  await expect(activity.getByRole("list", { name: "목표에서 다음 작업으로" })).toBeVisible();
  await expect(activity).toHaveAttribute("data-live", "true");
  stopped = true;
  await expect(activity).toHaveAttribute("data-live", "false");
  await expect(activity).toContainText("종료 확인 중");
  stopped = false;
  finished = true;
  await expect(activity).toContainText("최근 실행 종료");
  await expect(activity).toHaveAttribute("data-live", "false");
  finished = false;
  await expect(activity).toHaveAttribute("data-live", "true");
  overviewFailed = true;
  await expect(activity).toHaveAttribute("data-live", "false");
  await expect(active.locator(".overview-state")).toContainText("현재 상태 확인 필요");
  overviewFailed = false;
  terminationPending = true;
  await expect(overview.locator(".project-activity")).toHaveCount(0);
  await expect(overview).toContainText("이전 실행의 종료 확인 필요");
});

test("explains development continuation without presenting it as a required manual fix", async ({
  page,
}) => {
  await page.route("**/runs/*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.errorCode === "development_incomplete") {
      body.status = "waiting_retry";
      body.errorCode = "development_continue";
      body.stopReason = null;
    }
    await route.fulfill({ response, json: body });
  });
  await login(page);
  await page.getByRole("button", { name: /개발 검증 예제 example/ }).click();
  await page.getByRole("button", { name: /계산 오류 수정 기록/ }).click();
  const attention = page.getByRole("region", { name: "실행 보류 사유" });
  await expect(attention.getByRole("heading", { name: "후속 수정 대기" })).toBeVisible();
  await expect(attention).toContainText("저장된 변경과 검토 의견에서 이어갑니다");
  await expect(attention).not.toContainText("원인을 해결한 뒤 재개하세요");
});

test("shows unlimited retry caps without disabling manual recovery or losing usage", async ({
  page,
}) => {
  await page.route("**/projects/*/tasks", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const task of body.tasks) {
      if (task.instruction !== "계산 오류 수정 기록") continue;
      task.retryState = {
        policy: {
          version: 1,
          initialDelayMs: 10000,
          maxDelayMs: 300000,
          jitterRatio: 0.2,
          maxRetries: null,
          maxConsecutiveErrors: null,
          maxTotalRunMs: null,
        },
        retries: 9,
        consecutiveErrors: 4,
        totalRunMs: 7200000,
        lastError: "timeout",
        decisionRunId: null,
        nextAttemptAt: null,
        reason: "not_retryable",
      };
    }
    await route.fulfill({ response, json: body });
  });
  await login(page);
  await page.getByRole("button", { name: /개발 검증 예제 example/ }).click();
  await page.getByRole("button", { name: /계산 오류 수정 기록/ }).click();
  await expect(page.getByLabel("자동 복구 정책")).toContainText("재시도 9회 · 제한 없음");
  await expect(page.getByLabel("자동 복구 정책")).toContainText("같은 오류 4회 · 제한 없음");
  await expect(page.getByLabel("자동 복구 정책")).toContainText("누적 실행 7200초 · 제한 없음");
  await expect(page.getByRole("button", { name: "작업 재개", exact: true })).toBeEnabled();
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

test("keeps status labels still across navigation, filters and a real status update", async ({
  page,
}) => {
  let workStatus = "succeeded";
  await page.route("**/projects/*/tasks", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.tasks = body.tasks.map((task: Record<string, unknown>) => ({
      ...task,
      status: workStatus,
    }));
    body.tasks.unshift({
      ...body.tasks[0],
      id: "0cdd12bd-b3d5-4bb2-9d3a-49c8808f7c39",
      kind: "planning",
      status: "succeeded",
      instruction: "완료된 계획 기록",
    });
    await route.fulfill({ response, json: body });
  });
  await login(page);
  await page.getByRole("button", { name: /개발 검증 예제 example/ }).click();
  const assertStill = async () => {
    await expect(page.locator(".task-row").first()).toBeVisible();
    const animations = await page
      .locator(".task-row-meta, .task-row-meta span, .detail-top .status")
      .evaluateAll((elements) =>
        elements.map((element) => getComputedStyle(element).animationName),
      );
    expect(animations.every((name) => name === "none")).toBe(true);
  };
  await assertStill();
  const filters = page.getByRole("group", { name: "작업 종류 필터" });
  await filters.getByRole("button", { name: "계획", exact: true }).click();
  await expect(page.locator(".task-row")).toContainText("판단 완료");
  await assertStill();
  await openSection(page, "목표");
  await openSection(page, "작업");
  await assertStill();
  await filters.getByRole("button", { name: "실제 작업", exact: true }).click();
  workStatus = "blocked";
  await expect(page.locator(".task-row .status").first()).toHaveText("확인 필요");
  await assertStill();
  await page.getByRole("button", { name: "전체 현황", exact: true }).click();
  await page.getByRole("button", { name: /개발 검증 예제 example/ }).click();
  await assertStill();
});

test("filters by work status and returns from mobile detail without losing the list context", async ({
  page,
}, testInfo) => {
  await page.route("**/projects/*/tasks", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const sample = body.tasks[0];
    body.tasks = [
      {
        ...sample,
        id: "e56fd5a7-7918-4a68-a629-046a5f87c101",
        kind: "work",
        status: "blocked",
        instruction: "검증 환경 확인",
      },
      {
        ...sample,
        id: "e56fd5a7-7918-4a68-a629-046a5f87c102",
        kind: "work",
        status: "running",
        instruction: "응답 형식 구현",
      },
      {
        ...sample,
        id: "e56fd5a7-7918-4a68-a629-046a5f87c103",
        kind: "work",
        status: "succeeded",
        instruction: "오류 처리 검증",
      },
    ];
    await route.fulfill({ response, json: body });
  });
  await page.route("**/tasks/*/runs", (route) => route.fulfill({ json: { runs: [] } }));
  await login(page);
  await page.getByRole("button", { name: /개발 검증 예제 example/ }).click();
  const filter = page.getByRole("combobox", { name: "작업 상태 필터" });
  await expect(page.locator(".task-row")).toHaveCount(3);
  await filter.selectOption("attention");
  await expect(page.locator(".task-row")).toHaveCount(1);
  await expect(page.locator(".task-row")).toContainText("검증 환경 확인");
  await filter.selectOption("active");
  await expect(page.locator(".task-row")).toHaveCount(1);
  await expect(page.locator(".task-row")).toContainText("응답 형식 구현");
  await filter.selectOption("succeeded");
  await expect(page.locator(".task-row")).toHaveCount(1);
  await expect(page.locator(".task-row")).toContainText("오류 처리 검증");
  await page.getByRole("searchbox", { name: "작업 기록 검색" }).fill("없는 작업");
  await page.getByRole("button", { name: "필터 초기화" }).click();
  await expect(filter).toHaveValue("all");
  await expect(page.locator(".task-row")).toHaveCount(3);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".task-detail")).toBeHidden();
  await filter.selectOption("attention");
  const row = page.locator(".task-row");
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#detail-heading")).toBeFocused();
  await expect(page.locator("#detail-heading")).toHaveText("검증 환경 확인");
  await expect(page.locator(".task-column")).toBeHidden();
  await page.getByRole("button", { name: "작업 목록", exact: true }).click();
  await expect(row).toBeFocused();
  await expect(filter).toHaveValue("attention");
  await expect(page.locator(".task-detail")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("mobile-task-list.png"), fullPage: true });
});

test("can return to the mobile task list when reading a newly created task fails", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await createProject(page, "모바일 목록 조회 복구");
  await expect(page.locator(".task-column")).toContainText("아직 등록한 작업이 없습니다");
  await page.locator(".analysis-composer > summary").click();
  await page.getByLabel("분석 작업 등록", { exact: true }).fill("조회 복구 후 이어서 볼 분석");
  await page.route("**/projects/*/tasks", (route) =>
    route.request().method() === "GET" ? route.abort("failed") : route.continue(),
  );
  await page.getByRole("button", { name: "분석 요청", exact: true }).click();
  await expect(page.locator(".empty-detail [role=alert]")).toContainText(
    "서버에 연결하지 못했습니다",
  );
  await page.getByRole("button", { name: "작업 목록", exact: true }).click();
  await expect(page.locator(".task-column [role=alert]")).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "작업 기록 검색" })).toBeFocused();
  await page.unroute("**/projects/*/tasks");
  await expect(page.locator(".task-row")).toHaveCount(1);
  await page.locator(".task-row").click();
  await expect(page.locator("#detail-heading")).toHaveText("조회 복구 후 이어서 볼 분석");
  await expect(page.locator("#detail-heading")).toBeFocused();
});

test("starts with the work list and opens detail only when selected while keeping plans accessible", async ({
  page,
}) => {
  await login(page);
  const planIds = Array.from({ length: 20 }, () => crypto.randomUUID());
  let workCount = 0;
  let latestWorkTitle = "";
  await page.route("**/projects/*/tasks", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const work = body.tasks.filter((task: { kind: string }) => task.kind === "work");
    workCount = work.length;
    latestWorkTitle = work[0].instruction.split("\n")[0];
    body.tasks.unshift(
      ...planIds.map((id) => ({
        ...work[0],
        id,
        kind: "planning",
        instruction: "목표의 다음 개발 작업을 계획합니다.",
      })),
    );
    await route.fulfill({ response, json: body });
  });
  await page.getByRole("button", { name: /개발 검증 예제 example/ }).click();
  await expect(page.locator(".task-row").first()).toBeVisible();
  await expect(page.locator(".task-detail")).toBeHidden();
  await expect(page.locator(".task-row").first()).toContainText(latestWorkTitle);
  await page.locator(".task-row").first().click();
  await expect(page.locator("#detail-heading")).toHaveText(latestWorkTitle);
  await page.getByRole("button", { name: "작업 목록", exact: true }).click();
  await expect(page.locator(".task-row").first()).toBeFocused();
  await expect(page.locator(".task-detail")).toBeHidden();
  await expect(page.locator(".task-row")).toHaveCount(workCount);
  const filters = page.getByRole("group", { name: "작업 종류 필터" });
  await expect(filters.getByRole("button", { name: "실제 작업", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await filters.getByRole("button", { name: "계획", exact: true }).click();
  await expect(page.locator(".task-row")).toHaveCount(20);
  await page.locator(".task-row").first().click();
  await expect(page.locator("#detail-heading")).toHaveText("목표의 다음 개발 작업을 계획합니다.");
  await filters.getByRole("button", { name: "전체", exact: true }).click();
  await expect(page.locator(".task-row")).toHaveCount(workCount + 20);
});

test("filters work history without losing the inspected record when a new plan arrives", async ({
  page,
}, testInfo) => {
  await login(page);
  await page.getByRole("button", { name: /개발 검증 예제 example/ }).click();
  await expect(page.locator(".task-row").first()).toBeVisible();
  const initialCount = await page.locator(".task-row").count();
  await page.locator(".task-row").first().click();
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
  await expect(page.locator(".task-instruction pre")).toContainText(
    "검증 기준과 상세 작업 지시입니다.",
  );
  await expect(page.locator(".task-row")).toHaveCount(initialCount);
  await expect(page.locator("#detail-heading")).toHaveText(originalTitle);
  await expect(page.locator(".activity-totals dd")).toHaveText(totals);
  const instruction = page.locator(".task-instruction");
  await expect(instruction.locator("pre")).toBeHidden();
  await page.locator(".task-info > summary").click();
  await expect(instruction.locator("pre")).toBeVisible();
  await expect(instruction.locator("pre")).toContainText("검증 기준과 상세 작업 지시입니다.");
  await page.locator(".task-info > summary").click();
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
  const flow = page.getByRole("region", { name: "실행 흐름과 최근 활동" });
  await expect(flow).toContainText("마지막 실행 단계");
  await expect(flow.locator('[aria-current="step"]')).toHaveText("준비");
  await page.getByRole("tab", { name: "실행 기록", exact: true }).click();
  const technical = page.locator(".run-technical");
  await expect(technical.locator("dl")).toBeHidden();
  await technical.locator("summary").click();
  await expect(technical.locator("dl")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("work-history-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "작업 목록", exact: true }).click();
  await page.locator(".task-row").click();
  await expect(page.locator("#detail-heading")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator(".detail-top .status")).toHaveCSS("animation-name", "none");
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
  await expect(page.locator(".run-activity")).toContainText("마지막 실행 단계");
  await expect(page.locator(".run-activity")).not.toHaveClass(/is-current/);
  await current.getByRole("button").click();
  await expect(page.locator("#detail-heading")).toHaveText("오래 걸리는 현재 분석");
  await expect(page.locator("#detail-heading")).toBeFocused();
  const runActivity = page.getByRole("region", { name: "실행 흐름과 최근 활동" });
  await expect(runActivity).toContainText("진행 중인 단계");
  await expect(runActivity.locator("time")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("current-work-desktop.png"), fullPage: true });
  // A stale execution response must not make a stopped Task look live.
  await page.route("**/projects/*/tasks", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const task of body.tasks) if (task.status === "running") task.status = "blocked";
    await route.fulfill({ response, json: body });
  });
  await expect(page.locator(".detail-top .status-blocked")).toBeVisible();
  await expect(runActivity).not.toHaveClass(/is-current/);
  await page.unroute("**/projects/*/tasks");
  await expect(runActivity).toHaveClass(/is-current/);
  await page.route("**/execution", (route) => route.abort("failed"));
  await expect(page.locator(".connection")).toContainText("서버 연결 확인 필요");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".connection small")).toBeVisible();
  await expect(page.locator(".connection")).toHaveAttribute("title", /마지막 확인/);
  await expect(current).toHaveCount(0);
  await expect(runActivity).toContainText("연결 끊김 · 마지막 기록");
  await expect(runActivity).not.toHaveClass(/is-current/);
  await page.unroute("**/execution");
  await page.getByRole("button", { name: "작업 취소", exact: true }).click();
  await expect(page.locator(".detail-top .status-cancelled")).toBeVisible();
});

test("opens work status totals as matching lists and returns from mobile detail", async ({
  page,
}) => {
  await login(page);
  await page.route("**/projects/*/tasks", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    // Seeded records can share a timestamp; preserve the completed and blocked cases.
    const waiting = body.tasks.find(
      (task: { instruction: string }) => task.instruction === "준비 중단 기록",
    );
    expect(waiting).toBeDefined();
    waiting.status = "queued";
    await route.fulfill({ response, json: body });
  });
  await page.getByRole("button", { name: /개발 검증 예제 example/ }).click();
  await expect(page.locator(".task-row").first()).toBeVisible();
  await page.locator(".activity-counts > summary").click();
  for (const [name, value, status] of [
    ["완료한 작업 보기", "succeeded", ".status-succeeded"],
    [
      "실행 대기 작업 보기",
      "waiting",
      ".status-queued, .status-waiting_retry, .status-waiting_capacity",
    ],
    [
      "확인이 필요한 작업 보기",
      "attention",
      ".status-blocked, .status-failed, .status-interrupted",
    ],
  ] as const) {
    const shortcut = page.getByRole("button", { name, exact: true });
    const count = Number(await shortcut.innerText());
    expect(count).toBeGreaterThan(0);
    await shortcut.click();
    await expect(page.getByLabel("작업 상태 필터")).toHaveValue(value);
    await expect(page.locator(".task-row")).toHaveCount(count);
    await expect(page.locator(".task-row").locator(status)).toHaveCount(count);
    await expect(page.locator(".task-detail")).toBeHidden();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".task-row").first().click();
  await expect(page.locator("#detail-heading")).toBeInViewport();
  await page.getByRole("button", { name: "완료한 작업 보기", exact: true }).click();
  await expect(page.getByRole("region", { name: "작업 목록과 등록" })).toBeVisible();
  await expect(page.locator(".task-detail")).toBeHidden();
  await expect(page.getByLabel("작업 기록 검색")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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

test("shows the last planning reason while idle and withdraws it on fetch failure or a new goal version", async ({
  page,
}) => {
  let goalVersion = 1;
  let failResult = false;
  await page.route("**/execution", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), state: "idle", reason: null, taskId: null, runId: null },
    });
  });
  await page.route("**/projects/*/goals", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.goals = body.goals.map((goal: object) => ({
      ...goal,
      status: "active",
      version: goalVersion,
    }));
    await route.fulfill({ response, json: body });
  });
  await page.route("**/runs/*", (route) => (failResult ? route.abort("failed") : route.continue()));
  await login(page);
  await page.getByRole("button", { name: /관측 계획 예제 example/ }).click();
  const activity = page.getByRole("region", { name: "프로젝트 작업 현황" });
  const summary = activity.locator(".planning-summary");
  await expect(summary).toContainText("최신 관측을 다시 수집한 뒤 판단합니다.");
  await expect(summary.locator(".planning-summary-label")).toContainText("최근 판단 ·");
  await expect(page.locator(".task-detail")).toBeHidden();
  await summary.getByRole("button", { name: "판단 내용 보기", exact: true }).click();
  await expect(page.locator("#detail-heading")).toHaveText("관측을 확인한 계획 기록");
  await page.getByRole("button", { name: "작업 목록", exact: true }).click();
  failResult = true;
  await expect(summary).toContainText("최근 판단을 불러오지 못했습니다", { timeout: 20000 });
  await expect(summary).not.toContainText("최신 관측을 다시 수집한 뒤 판단합니다.");
  goalVersion = 2;
  await expect(summary).toHaveCount(0);
  await expect(activity.getByRole("button", { name: "목표 확인", exact: true })).toBeVisible();
});

test("shows the actual unresolved finding before recovery controls and links to the held work", async ({
  page,
}, testInfo) => {
  await page.route("**/execution", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), state: "idle", reason: null, taskId: null, runId: null },
    });
  });
  await login(page);
  await createProject(page, "보류 원인 확인 예제");
  await createTask(page, "주문 응답 검증");
  await expect(page.locator(".detail-top .status-succeeded")).toBeVisible();
  const finding =
    "서버 테스트는 통과했지만 실행 환경의 버전 확인이 필요합니다. <script>window.unwanted=true</script>";
  let fallbackReport = false;
  const longReport = `검증 근거를 확인해야 합니다: ${"x".repeat(400)}`;
  await page.route("**/projects/*/tasks", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.tasks[0].status = "blocked";
    await route.fulfill({ response, json: body });
  });
  await page.route("**/runs/*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.status = "blocked";
    body.errorCode = "analysis_incomplete";
    body.result = null;
    body.steps.at(-1).assessment = {
      report: fallbackReport ? longReport : "실행 환경 확인 후 검토를 이어갈 수 있습니다.",
      evidence: ["서버 테스트 종료 코드 0"],
      unresolved: fallbackReport ? [] : [finding],
      complete: false,
      next: null,
    };
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  const activity = page.getByRole("region", { name: "프로젝트 작업 현황" });
  await expect(activity).toContainText("확인 후 이어갈 작업이 있어요");
  await activity.getByRole("button", { name: "보류 사유 확인" }).click();
  await expect(page.locator("#detail-heading")).toBeFocused();
  const attention = page.getByRole("region", { name: "실행 보류 사유" });
  await expect(attention.locator(".unresolved-list")).toBeHidden();
  await expect(attention.locator(":scope > p").first()).toHaveText(finding);
  const findings = attention.locator(".attention-findings");
  await findings.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(attention.getByRole("listitem")).toBeVisible();
  await expect(attention.getByRole("listitem")).toHaveText(finding);
  await expect(attention).toContainText("같은 지시로 다시 실행");
  await expect(attention.locator("code")).toBeHidden();
  expect(await page.evaluate(() => "unwanted" in window)).toBe(false);
  const warningBox = await attention.boundingBox();
  expect(warningBox!.y).toBeLessThan((await page.locator(".task-actions").boundingBox())!.y);
  await attention.locator(".attention-technical summary").click();
  await expect(attention.locator("code")).toHaveText("analysis_incomplete");
  await page.screenshot({ path: testInfo.outputPath("unresolved-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await activity.getByRole("button", { name: "보류 사유 확인" }).click();
  await expect(page.locator("#detail-heading")).toBeInViewport();
  fallbackReport = true;
  await expect(attention.locator(".blocker-report")).toHaveText(longReport);
  await findings.locator("summary").click();
  await expect(attention.locator(".blocker-report")).toBeHidden();
  await expect(attention.locator(":scope > p").first()).toHaveText(`${longReport.slice(0, 160)}…`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.route("**/execution", (route) => route.abort("failed"));
  await expect(activity).toContainText("현재 상태를 확인할 수 없어요");
  await expect(activity.getByRole("button", { name: "보류 사유 확인" })).toHaveCount(0);
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
  await openTask(page, /반영 완료 기록/);
  await expect(page.locator(".detail-top .status-succeeded")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  const result = page.locator(".run-result > .analysis-result");
  await expect(result).toBeInViewport({ ratio: 1 });
  await page.getByRole("tab", { name: "실행 기록", exact: true }).click();
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
  await openTask(page, /반영 완료 기록/);
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

test("reads report code in a safe console, copies and wraps it, and preserves context in focus view", async ({
  page,
  context,
}, testInfo) => {
  const source = 'const message = "' + "긴 출력 문자열 ".repeat(30) + '";\nconsole.log(message);';
  const report =
    "## 결과 서식 확인용 예제\n\n- 완료한 변경과 검증을 구분합니다.\n\n```ts\n" +
    source +
    "\n```\n\n<script>window.unwanted = true</script>\n\n![추적](https://example.invalid/report-image)";
  let runReads = 0;
  const remoteRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://example.invalid/")) remoteRequests.push(request.url());
  });
  await page.route("**/runs/*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.status === "succeeded") body.result = report;
    runReads++;
    await route.fulfill({ response, json: body });
  });
  await login(page);
  await createProject(page, "콘솔 표시 예제");
  await createTask(page, "개발 결과의 코드와 검증 기록을 읽습니다.");
  const result = page.getByRole("tabpanel", { name: "결과", exact: true });
  await expect(result.getByRole("heading", { name: "결과 서식 확인용 예제" })).toBeVisible();
  const terminal = result.getByRole("region", { name: "코드 · ts", exact: true });
  await expect(terminal).toBeVisible();
  await expect(terminal.locator("code")).toHaveText(source);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await terminal.getByRole("button", { name: "복사", exact: true }).click();
  await expect(terminal.getByRole("status")).toHaveText("복사됨");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
  await expect(result.getByText("[이미지: 추적]", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => "unwanted" in window)).toBe(false);
  expect(remoteRequests).toEqual([]);

  const resultTab = page.getByRole("tab", { name: "결과", exact: true });
  const historyTab = page.getByRole("tab", { name: "실행 기록", exact: true });
  await resultTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(historyTab).toBeFocused();
  await expect(historyTab).toHaveAttribute("aria-selected", "true");
  await expect(result).toBeHidden();
  const readsBefore = runReads;
  await expect.poll(() => runReads).toBeGreaterThan(readsBefore);
  await expect(historyTab).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(resultTab).toBeFocused();
  await expect(terminal).toBeVisible();

  await page.getByRole("button", { name: "집중 보기", exact: true }).click();
  await expect(page.getByRole("region", { name: "작업 목록과 등록" })).toBeHidden();
  await expect(terminal).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("console-focus-desktop.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "집중 보기", exact: true })).toBeFocused();
  await expect(page.getByRole("region", { name: "작업 목록과 등록" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await terminal.locator("pre").evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  await terminal.getByRole("button", { name: "줄바꿈", exact: true }).click();
  await expect(terminal.getByRole("button", { name: "줄바꿈", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    await terminal.locator("pre").evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async () => {
        throw new DOMException("Denied", "NotAllowedError");
      },
    }),
  );
  await terminal.getByRole("button", { name: "복사", exact: true }).click();
  await expect(terminal.getByRole("status")).toContainText("복사하지 못했습니다.");
  await page.screenshot({ path: testInfo.outputPath("console-mobile.png"), fullPage: true });
});
