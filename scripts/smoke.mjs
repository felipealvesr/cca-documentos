import { _electron as electron } from "playwright";
import electronBinary from "electron";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
await mkdir("test-results", { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const installed = process.env.CCA_TEST_EXE;
const packagedAsar = process.env.CCA_TEST_ASAR;
const prefix = installed
  ? "installed"
  : process.env.CCA_DEV_URL
    ? "development"
    : "production";
const smokeUserData = path.resolve(`.cache/${prefix}-smoke-user-data`);
const app = await electron.launch({
  executablePath: installed ?? electronBinary,
  args: packagedAsar
    ? [packagedAsar, `--user-data-dir=${smokeUserData}`]
    : installed
      ? [`--user-data-dir=${smokeUserData}`]
      : ["."],
  env,
  timeout: 60000,
});
try {
  const window = await app.firstWindow();
  const errors = [];
  window.on("pageerror", (error) => errors.push(error.message));
  await window
    .getByRole("button", { name: "Selecionar documento" })
    .waitFor({ timeout: 30000 });
  await window.screenshot({ path: `test-results/${prefix}-welcome.png` });
  const importFile = async (file) => {
    const before = await window.locator(".document-tabs > button").count();
    await app.evaluate(
      ({ dialog }, filePath) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [filePath],
        });
      },
      path.resolve(`tests/fixtures/${file}`),
    );
    await window
      .getByRole("button", { name: /Selecionar documento|Adicionar documento/ })
      .click();
    await window.waitForFunction(
      (count) =>
        document.querySelectorAll(".document-tabs > button").length > count ||
        !!document.querySelector(".error-notice"),
      before,
      { timeout: 120000 },
    );
    if (await window.locator(".error-notice").count())
      throw new Error(await window.locator(".error-notice").textContent());
    await window
      .getByRole("button", { name: "Cancelar leitura" })
      .waitFor({ state: "hidden", timeout: 120000 });
  };
  await importFile("desconhecido.png");
  assert.equal(
    await window.locator("#field-cpf").inputValue(),
    "123.456.789-09",
  );
  assert.equal(await window.locator("#field-cnh").inputValue(), "01234567890");
  assert.equal(
    await window.locator("#field-fatherName").inputValue(),
    "JOAO DA SILVA",
  );
  assert.equal(
    await window
      .getByRole("button", { name: "Iniciar cadastro", exact: true })
      .isDisabled(),
    true,
  );
  await window.getByRole("checkbox").check();
  assert.equal(
    await window
      .getByRole("button", { name: "Iniciar cadastro", exact: true })
      .isEnabled(),
    true,
  );
  // Never click start: this test does not contact CAIXA or submit fictitious identities.
  await window.locator("#field-fatherName").fill("JOAO SILVA");
  assert.equal(await window.getByRole("checkbox").isChecked(), false);
  await window.locator("#field-fatherName").fill("JOAO DA SILVA");
  await window.screenshot({
    path: `test-results/${prefix}-review.png`,
    fullPage: true,
  });
  await importFile("pdf-digital.pdf");
  assert.equal(await window.locator(".document-tabs > button").count(), 2);
  assert.equal(
    await window.locator("#field-cpf").inputValue(),
    "123.456.789-09",
  );
  const analyzeMetadata = async (file) =>
    window.evaluate(
      async ({ file, bytes }) => {
        const result = await window.cca.analyze({
          id: "metadata-check",
          name: file,
          bytes: new Uint8Array(bytes),
        });
        return {
          pages: result.ocr.pages.map((p) => ({
            method: p.method,
            model: p.model,
            metrics: p.metrics,
          })),
          fieldCount: result.candidates.length,
        };
      },
      { file, bytes: Array.from(await readFile(`tests/fixtures/${file}`)) },
    );
  const digital = await analyzeMetadata("pdf-digital.pdf");
  assert.deepEqual(
    digital.pages.map((p) => p.method),
    ["text"],
  );
  const fallback = await analyzeMetadata("cpf-invalido.png");
  assert.equal(fallback.pages[0].metrics.fallbackUsed, true);
  assert.ok(fallback.pages[0].metrics.mediumMs > 0);
  await importFile("cpf-invalido.png");
  assert.ok((await window.locator(".conflict").count()) > 0);
  assert.equal(
    await window
      .getByRole("button", { name: "Iniciar cadastro", exact: true })
      .isDisabled(),
    true,
  );
  await window
    .locator(".conflict button")
    .filter({ hasText: "123.456.789-09" })
    .first()
    .click();
  assert.equal(
    await window.locator("#field-cpf").inputValue(),
    "123.456.789-09",
  );
  const snapshot = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return {
      title: w.getTitle(),
      sandbox: w.webContents.getLastWebPreferences().sandbox,
      contextIsolation: w.webContents.getLastWebPreferences().contextIsolation,
      nodeIntegration: w.webContents.getLastWebPreferences().nodeIntegration,
    };
  });
  assert.equal(snapshot.sandbox, true);
  assert.equal(snapshot.contextIsolation, true);
  assert.equal(snapshot.nodeIntegration, false);
  assert.deepEqual(errors, []);
  await writeFile(
    `test-results/${prefix}-smoke.json`,
    JSON.stringify(
      {
        success: true,
        input: ["image", "digital-pdf"],
        directText: digital,
        fallback,
        conflictSelection: true,
        manualReviewGate: true,
        correctionsResetConfirmation: true,
        manualCorrectionCount: 3,
        security: snapshot,
        rendererErrors: errors,
        bankContacted: false,
      },
      null,
      2,
    ),
  );
  console.log(
    `${prefix}: real OCR, PDF, editable fields and confirmation gate passed.`,
  );
} finally {
  await app.close();
}
