import { test, expect } from "@playwright/test";

test("owner publishes only a chosen name, visitors cannot issue work, and unpublishing withdraws the project", async ({
  page,
  browser,
}, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "목표에서 다음 작업까지" })).toBeVisible();
  await page.getByRole("link", { name: "관리자 로그인" }).click();
  await page.getByLabel("비밀번호", { exact: true }).fill("browser-fixture-password");
  await page.getByRole("button", { name: "작업 공간 열기" }).click();
  await page.getByRole("button", { name: "프로젝트 등록 +", exact: true }).click();
  await page.getByLabel("프로젝트 이름", { exact: true }).fill("소유자만 아는 이름");
  await page.getByLabel("작업 공간 키", { exact: true }).fill("example");
  await page.getByRole("button", { name: "프로젝트 등록", exact: true }).click();
  const settings = page.getByRole("region", { name: "프로젝트 공개 설정" });
  await settings.locator("summary").click();
  await page.getByLabel("공개용 이름", { exact: true }).fill("공개 작업실");
  await page.getByLabel("방문자에게 공개", { exact: true }).check();
  await page.getByRole("button", { name: "공개 설정 저장" }).click();
  await expect(settings.locator("summary")).toHaveText("공개 여부 공개");
  const visitorContext = await browser.newContext();
  try {
    const visitor = await visitorContext.newPage();
    await visitor.goto("http://127.0.0.1:4320/");
    await expect(visitor.getByRole("heading", { name: "공개 작업실", exact: true })).toBeVisible();
    await expect(visitor.locator("body")).not.toContainText("소유자만 아는 이름");
    await expect(visitor.getByRole("button", { name: /목표 등록|분석 요청|일시정지/ })).toHaveCount(
      0,
    );
    expect((await visitor.request.get("http://127.0.0.1:4320/projects")).status()).toBe(401);
    await visitor.getByRole("button", { name: /공개 작업실/ }).click();
    await expect(visitor.getByRole("button", { name: /공개 작업실/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await visitor.screenshot({ path: testInfo.outputPath("public-desktop.png"), fullPage: true });
    await visitor.setViewportSize({ width: 390, height: 844 });
    expect(await visitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await visitor.screenshot({ path: testInfo.outputPath("public-mobile.png"), fullPage: true });
    // Lost connectivity must hide the old public data, not retain a revoked name.
    await visitor.route("**/public/projects?*", (route) =>
      route.fulfill({ status: 503, body: "{}" }),
    );
    await expect(visitor.getByRole("alert")).toBeVisible();
    await expect(visitor.getByRole("heading", { name: "공개 작업실" })).toHaveCount(0);
    await visitor.unroute("**/public/projects?*");
    await visitor.getByRole("button", { name: "다시 확인" }).click();
    await expect(visitor.getByRole("heading", { name: "공개 작업실" })).toBeVisible();
    await page.getByLabel("방문자에게 공개", { exact: true }).uncheck();
    await page.getByRole("button", { name: "공개 설정 저장" }).click();
    await expect(settings.locator("summary")).toHaveText("공개 여부 비공개");
    await expect(visitor.getByRole("heading", { name: "공개 작업실" })).toHaveCount(0);
  } finally {
    await visitorContext.close();
  }
  const goals = page.getByRole("region", { name: "프로젝트 목표", exact: true });
  await goals.locator("summary").first().click();
  await goals.getByRole("button", { name: "목표 등록 +" }).click();
  await expect(page.getByRole("dialog", { name: "목표 추가" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "프로젝트 목표", exact: true })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("goal-drawer-mobile.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(goals.getByRole("button", { name: "목표 등록 +" })).toBeFocused();
});
