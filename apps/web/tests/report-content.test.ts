import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { expect, test } from "vitest";
import { ReportContent } from "../src/shared/ReportContent.js";

test("renders headings and lists as prose and fenced source as a read-only console", async () => {
  const stream = await renderToReadableStream(
    createElement(ReportContent, {
      text: "## 수정 결과\n\n- 중복 주문 처리\n\n```ts\nconst order = '<script>unsafe()</script>';\n```",
    }),
  );
  await stream.allReady;
  const html = await new Response(stream).text();
  expect(html).toContain("<h4>수정 결과</h4>");
  expect(html).toContain("<li>중복 주문 처리</li>");
  expect(html).toContain("코드 · ts");
  expect(html).toContain("읽기 전용");
  expect(html).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
  expect(html).not.toContain("<script>");
});

test("escapes raw HTML, rejects script links and never loads model-provided images", async () => {
  const stream = await renderToReadableStream(
    createElement(ReportContent, {
      text: '<script>window.unwanted = true</script>\n\n[실행](javascript:alert%281%29)\n\n![추적](https://example.invalid/private-image)\n\n<img src="https://example.invalid/raw" onerror="unsafe()">',
    }),
  );
  await stream.allReady;
  const html = await new Response(stream).text();
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("[이미지: 추적]");
});

test("keeps incomplete code fences readable while output is still being recorded", async () => {
  const stream = await renderToReadableStream(
    createElement(ReportContent, { text: "결과\n\n```sh\npnpm test\n" }),
  );
  await stream.allReady;
  const html = await new Response(stream).text();
  expect(html).toContain("코드 · sh");
  expect(html).toContain("pnpm test");
  expect(html).toContain("결과");
});
