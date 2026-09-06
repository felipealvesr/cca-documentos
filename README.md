# CCA Documentos

MVP desktop para conferir documentos pessoais e alimentar a automação existente do CAIXA Aqui. Interface em português, Electron + React + TypeScript + Vite + Tailwind + Lucide.

## Usar

Instale `release/CCA-Setup.exe` no Windows 10/11 x64. O instalador inclui os modelos, o motor OCR, o runtime portátil, o leitor de PDF e o protótipo original. Não é necessário instalar Python, Node, pip, PaddlePaddle ou ONNX Runtime. O Google Chrome continua sendo necessário para a automação do protótipo.

1. Selecione ou arraste PDF, JPG, JPEG ou PNG.
2. Aguarde a leitura local e compare os dados com a imagem.
3. Corrija os campos, resolva divergências e adicione outro documento quando necessário.
4. Confirme que conferiu os dados e que os documentos são do mesmo cliente.
5. Com pelo menos um documento, nome preenchido e um CPF ou número de CNH válido, marque a conferência e clique em **Iniciar cadastro**. Faça o login habitual no Chrome, abra **CPF do Cliente** e confirme na interface que a tela está pronta.
6. CPF, nome do pai e CNH são enviados à automação somente quando estiverem disponíveis e válidos. O executável original consulta CPF, preenche os dados de identificação positiva disponíveis e para na tela cadastral final. O CCA não salva, avança ou conclui essa tela.

Limites do MVP: 25 MB por arquivo, 15 páginas por PDF, 10 documentos por operação. PDFs protegidos devem ser desbloqueados antes da importação. Informações ausentes podem ser digitadas. Um documento desconhecido continua sendo processado. A filiação sem rótulos recebe uma indicação explícita para conferir a ordem pai/mãe.

## Pipeline implementado

```text
PDF → detecção de texto por página → texto direto quando utilizável
                                      │
Imagem / página digitalizada → PP-OCRv6 Small
                                      ↓
                     texto + posição + confiança + página
                                      ↓
                         extração genérica de campos
                                      ↓
                         normalização + validações
                                      ↓
          problema detectado em OCR? → PP-OCRv6 Medium, uma tentativa
                                      ↓
                     consolidação + conferência humana
                                      ↓
                         automação original CCA_v1
```

O runtime escolhido é **RapidOCR 3.9.2 + ONNX Runtime 1.24.3, CPU**, com detecção e reconhecimento PP-OCRv6 Small. Detecção e reconhecimento Medium são carregados apenas sob demanda. Os modelos permanecem carregados durante a sessão; cancelar a leitura encerra o worker, que pode ser reiniciado na próxima importação. O classificador leve de orientação de linhas acompanha o runtime.

O worker é um componente portátil composto por `cca-ocr.exe`, runtime CPython isolado, bibliotecas e modelos locais. A comunicação usa JSON por stdin/stdout, com a imagem em memória. Não existe servidor HTTP, serviço Windows, Docker, backend ou banco de dados.

O score considera confiança, campos válidos, divergências e rótulos de campos prioritários sem valor. A falta de CNH em uma CIN, por si só, não dispara Medium. CPF encontrado com dígitos inválidos dispara uma tentativa adicional. Um resultado ruim continua disponível para revisão; não há repetição ilimitada. Um PDF com texto utilizável nunca passa por OCR automático.

A extração utiliza rótulos compartilhados, linhas vizinhas, proximidade horizontal/vertical, padrões de dados e classificação auxiliar. O reconhecimento do tipo não seleciona um template obrigatório. Campos extras com rótulo e valor são preservados, e o texto completo fica disponível na visualização. A extração heurística não promete interpretar todo campo de qualquer documento.

## Código

- `electron/main.ts`: janela, permissões e IPC.
- `electron/ocr.ts`: carregamento de documentos, PDF direto e seleção Small/Medium.
- `electron/paddle-worker.ts`: ciclo de vida e protocolo do worker local.
- `ocr-worker/worker.py`: inferência RapidOCR/ONNX, sem interpretação de campos.
- `src/shared/extract.ts`: classificação e interpretação genérica.
- `src/shared/fields.ts`: normalização brasileira e validações.
- `src/shared/quality.ts`: critérios determinísticos para fallback.
- `src/shared/consolidate.ts`: consolidação, fontes e conflitos.
- `electron/automation.ts`: integração com o executável original.
- `electron/updater.ts`: verificação, download e instalação das releases do GitHub.
- `src/App.tsx`: importação, preview, edição e confirmação.

## Desenvolvimento e build

Na máquina de desenvolvimento: Node 22+ e pnpm; Python 3.12 x64 apenas para preparar os recursos do build. Microsoft Visual C++ x64 Redistributable deve estar disponível na máquina de build para incluir suas DLLs no pacote.

```powershell
pnpm install
python scripts/prepare-ocr.py
pnpm assets
pnpm dev
pnpm test
pnpm build
pnpm dist
```

Os scripts também podem ser iniciados com `npm run dev`, `npm run build`, `npm test` e `npm run dist` depois da instalação das dependências. O projeto inclui `pnpm-lock.yaml`. `prepare-ocr.py` é a única etapa que baixa os recursos do OCR; o aplicativo instalado não faz download. Os hashes dos modelos estão em `ocr-worker/models.json`. Versões transitivas do worker ficam registradas em `ocr-worker/runtime-lock.txt`.

```powershell
node scripts/fixtures.mjs
node scripts/benchmark.mjs
node scripts/test-fallback.mjs
node scripts/test-prototype.mjs
node scripts/smoke.mjs
# Para testar o aplicativo instalado:
$env:CCA_TEST_EXE = 'CAMINHO\CCA.exe'
node scripts/smoke.mjs
```

## Atualizações por release

O aplicativo instalado verifica a release mais recente de
`github.com/felipealvesr/cca-documentos` alguns segundos depois de abrir. Ao
encontrar uma versão nova, o funcionário escolhe quando baixar e instalar. O
download é salvo apenas na pasta de dados do aplicativo, conferido pelo tamanho
e pelo SHA-512 publicado no `latest.yml`; depois o instalador NSIS é executado e
o CCA reinicia. Builds de desenvolvimento não fazem essa verificação.

Para publicar uma versão, altere o `version` do `package.json`, gere a release
e envie uma tag correspondente (por exemplo, `v0.2.1`). O workflow
`.github/workflows/release.yml` executa o build em Windows e publica a Release
automaticamente usando `GITHUB_TOKEN`:

```powershell
git tag v0.2.1
git push origin v0.2.1
```

O workflow publica `CCA-Setup.exe`, `latest.yml` e o `.blockmap`. A release deve
permanecer publicada para que os clientes encontrem a atualização. Se uma
release já existir sem os arquivos, execute o workflow manualmente em **Actions
→ Release Windows → Run workflow**, informando a tag para repará-la.

Os testes usam somente documentos sintéticos, identificados como amostras sem validade. Não existe documento pessoal real/sanitizado no ZIP original: apenas executável, instruções e JSON de exemplo. Os testes não acessam o CAIXA Aqui nem enviam dados fictícios a ele. Os resultados e limitações estão em `docs/VALIDACAO.md`.

## Privacidade e segurança

- Documentos e texto OCR permanecem em memória. Não há histórico de clientes nem logs de conteúdo pessoal.
- O worker bloqueia conexões de rede. Os modelos possuem caminhos locais explícitos; o OCR funciona sem internet.
- Electron usa sandbox, isolamento de contexto, renderer sem Node, CSP e IPC restrito. A interface não carrega conteúdo remoto.
- Somente os três campos confirmados são entregues ao protótipo. Por compatibilidade com o executável fechado, a ponte cria um JSON temporário na pasta local da operação. Ele é removido ao encerrar; resíduos de encerramento abrupto são limpos na próxima abertura.
- O perfil Chrome do protótipo permanece em `%LOCALAPPDATA%\CCA_v1\ChromeProfile`, conforme o comportamento original. O CCA não captura a senha do funcionário.

## Ícone e distribuição

Não foi fornecido asset oficial de marca. O ícone próprio usa azul, laranja, documento e cantos de captura. Fonte vetorial: `assets/icon.svg`. `assets/icon.png` possui 512 px e `assets/icon.ico` contém 16, 24, 32, 48, 64, 128 e 256 px. O electron-builder configura aplicação, instalador NSIS, desinstalador e atalhos com esse ícone.

O build não possui certificado de assinatura de código próprio; para distribuição corporativa, a organização poderá assinar o pacote. O atualizador usa somente HTTPS e as releases oficiais do repositório configurado no `electron/updater.ts`; não há cloud OCR ou login próprio.

## Referências dos componentes

- [Modelos e configuração RapidOCR](https://github.com/RapidAI/RapidOCR/blob/main/python/rapidocr/default_models.yaml)
- [PP-OCRv6 — documentação oficial](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/algorithm/PP-OCRv6/PP-OCRv6.en.md)
- [Segurança do Electron](https://www.electronjs.org/docs/latest/tutorial/security)
- [Instalador NSIS](https://www.electron.build/v26/docs/nsis/)

Uma integração futura com um serviço corporativo de extração poderá implementar a interface de provider. Nenhuma integração cloud está implementada ou é necessária neste MVP.
