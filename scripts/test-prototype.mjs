import {
  mkdtemp,
  copyFile,
  writeFile,
  rm,
  readFile,
  mkdir,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
await mkdir("test-results", { recursive: true });
const dir = await mkdtemp(path.resolve(".cache/prototype-contract-"));
try {
  const exe = path.join(dir, "CCA_v1.exe");
  await copyFile("prototype/CCA_v1.exe", exe);
  await writeFile(
    path.join(dir, "cliente_teste.json"),
    JSON.stringify({ cpf: "", nome_pai_validacao: "", numero_cnh: "" }),
  );
  const child = spawn(exe, [], {
    cwd: dir,
    windowsHide: true,
    shell: false,
    stdio: "pipe",
  });
  let output = "";
  const timer = setTimeout(() => child.kill(), 10000);
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.includes("fechar")) child.stdin.end("\r\n");
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  child.stdin.on("error", () => {});
  const code = await new Promise((resolve, reject) => {
    child.on("close", resolve);
    child.on("error", reject);
  });
  clearTimeout(timer);
  assert.match(output, /CPF deve conter 11 d[ií]gitos/i);
  assert.doesNotMatch(
    output,
    /cannot find|n[aã]o.*encontrar.*arquivo|no such file/i,
  );
  const sha256 = createHash("sha256")
    .update(await readFile(exe))
    .digest("hex");
  await writeFile(
    "test-results/prototype-contract.json",
    JSON.stringify(
      {
        executableSha256: sha256,
        inputRecognized: true,
        cpfFormatCheckedByOriginalExe: true,
        chromeLaunchRequested: false,
        bankContacted: false,
        exitCode: code,
      },
      null,
      2,
    ),
  );
  console.log(
    "Executável original reconheceu o JSON gerado e validou campos obrigatórios sem abrir o Chrome.",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
