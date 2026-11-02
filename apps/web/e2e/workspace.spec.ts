import { test, expect, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill("browser-fixture-password");
  const response = page.waitForResponse(
    (value) =>
      value.url().endsWith("/auth/login") &&
      value.request().method() === "POST",
  );
  await page.getByRole("button", { name: "작업 공간 열기" }).click();
  const result = await response;
  if (result.status() === 429) {
    // 여러 시나리오가 같은 임시 서버를 사용합니다. 제품의 인증 제한을 끄지 않고 기다립니다.
    const seconds = Number(result.headers()["retry-after"]);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(60);
    await page.waitForTimeout((seconds + 1) * 1000);
    await page.getByRole("button", { name: "작업 공간 열기" }).click();
  }
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
}
async function createProject(page: Page, name: string) {
  await page
    .getByRole("button", { name: "프로젝트 등록 +", exact: true })
    .click();
  await page.getByLabel("프로젝트 이름", { exact: true }).fill(name);
  await page.getByLabel("작업 공간 키", { exact: true }).fill("example");
  await page
    .getByRole("button", { name: "프로젝트 등록", exact: true })
    .click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}
async function createTask(page: Page, instruction: string) {
  await page.getByLabel("분석 작업 등록", { exact: true }).fill(instruction);
  await page.getByRole("button", { name: "분석 요청", exact: true }).click();
  await expect(page.locator("#detail-heading")).toHaveText(instruction);
}

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
  await expect(page.locator(".run-facts")).toContainText("xhigh");
  await expect(page.locator(".run-facts")).toContainText(
    "여러 시스템의 복잡한 원인 분석",
  );
  await expect(page.locator(".run-record > .analysis-result")).toContainText(
    "<script>",
  );
  await expect(page.locator(".detail-top .status-succeeded")).toBeVisible();
  expect(await page.evaluate(() => "unwanted" in window)).toBe(false);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.locator(".run-record > .analysis-result")).toBeVisible();
  expect(errors).toEqual([]);
  await page.getByRole("button", { name: /관측 예제/ }).click();
  await expect(page.locator(".services-panel")).toHaveCount(1);
  await expect(page.locator(".service-state")).toHaveText("정상 대기");
  await expect(page.locator(".service-evidence")).not.toHaveClass(/historical/);
  await request.post("http://127.0.0.1:4321/fixture/failure");
  await expect(page.locator(".service-state")).toHaveText("관측 실패");
  await expect(page.locator(".service-evidence.historical")).toContainText(
    "이전 수집 기록",
  );
  await expect(page.locator(".service-summary")).toContainText("새 학습 기록");
  await request.post("http://127.0.0.1:4321/fixture/stale");
  await expect(page.locator(".service-state")).toHaveText("오래된 정보");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
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
  await expect(
    page.getByText("이전 실행 기록입니다.", { exact: false }),
  ).toBeVisible();
  await createTask(page, "오래 분석하는 작업입니다.");
  await expect(page.locator(".detail-top .status-running")).toBeVisible();
  await page.getByRole("button", { name: "작업 취소", exact: true }).click();
  await expect(page.locator(".detail-top .status-cancelled")).toBeVisible();
  await createTask(page, "한도 응답을 확인해 줘.");
  await expect(
    page.locator(".detail-top .status-waiting_capacity"),
  ).toBeVisible();
  await expect(page.locator(".execution-bar")).toContainText(
    "계정 사용량 제한",
  );
  await expect(page.getByLabel("계정 사용량 확인")).toContainText(
    "계정 확인 0 / 3회",
  );
  await expect(page.getByLabel("계정 사용량 확인")).toContainText(
    "다음 확인 가능 시각",
  );
  await expect(page.locator(".execution-bar")).toContainText(
    "제공자 재시도 시각 미제공",
  );
  await page.screenshot({
    path: testInfo.outputPath("capacity-wait.png"),
    fullPage: true,
  });
  await createTask(page, "회복 확인용 새 작업입니다.");
  await expect(page.locator(".detail-top .status-queued")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "작업 재개", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".detail-top .status-succeeded")).toBeVisible();
  await expect(page.locator(".execution-bar")).not.toContainText(
    "계정 사용량 제한",
  );
});

test("keeps last records on disconnect and returns to login after session expiry and logout", async ({
  page,
  context,
}) => {
  await login(page);
  await createProject(page, "연결 상태 확인");
  await context.setOffline(true);
  await expect(
    page.getByText("서버 연결 확인 필요", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "연결 상태 확인", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".connection")).toContainText("마지막 확인");
  await context.setOffline(false);
  await expect(page.getByText("서버 연결됨", { exact: false })).toBeVisible();
  await context.clearCookies();
  await expect(
    page.getByRole("heading", { name: "로그인", exact: true }),
  ).toBeVisible();
  await login(page);
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "로그인", exact: true }),
  ).toBeVisible();
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
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
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
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("workflow-mobile.png"),
    fullPage: true,
  });
});
