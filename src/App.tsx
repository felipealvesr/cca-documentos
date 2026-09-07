import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Download,
  FilePlus2,
  FileScan,
  FileText,
  Fingerprint,
  Info,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RotateCcw,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type {
  AutomationPhase,
  AutomationStatus,
  AppUpdateStatus,
  Candidate,
  DocumentInput,
  ProcessedDocument,
  Progress,
  ReviewField,
  ReviewKey,
} from "./shared/types";
import {
  FIELD_LABELS,
  PRIMARY,
  fold,
  normalize,
  validate,
} from "./shared/fields";
import { consolidate } from "./shared/consolidate";

const api = window.cca;
const AUTOMATION_STEPS: { label: string; phases: AutomationPhase[] }[] = [
  { label: "Abrir o navegador", phases: ["opening"] },
  { label: "Login e tela CPF do Cliente", phases: ["waiting"] },
  { label: "Consulta do CPF", phases: ["cpf"] },
  { label: "Identificação positiva", phases: ["identification"] },
  { label: "Tela cadastral", phases: ["final", "done"] },
];
const errorMessage = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );
export default function App() {
  const [documents, setDocuments] = useState<ProcessedDocument[]>([]);
  const [edits, setEdits] = useState<Partial<Record<ReviewKey, string>>>({});
  const [recheckEdits, setRecheckEdits] = useState<ReviewKey[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress>();
  const [readingName, setReadingName] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [raw, setRaw] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [help, setHelp] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [highlight, setHighlight] = useState<Candidate>();
  const [automation, setAutomation] = useState<AutomationStatus>({
    phase: "idle",
    message: "",
  });
  const [automationOpen, setAutomationOpen] = useState(false);
  // The run can stop at any step. Remembering the last one keeps the list
  // showing where it stopped instead of collapsing into a single error line.
  const [stoppedAt, setStoppedAt] = useState(0);
  const [update, setUpdate] = useState<AppUpdateStatus>({
    phase: "idle",
    message: "",
  });
  const cancelled = useRef(false);
  const busyRef = useRef(false);
  const fields = consolidate(documents, edits).map((field) =>
    recheckEdits.includes(field.key) ? { ...field, conflict: true } : field,
  );
  const selected = documents.find((d) => d.id === selectedId) ?? documents[0];
  const selectedPage = selected?.ocr.pages[page];
  const conflicts = fields.filter((f) => f.conflict).length;
  const valueOf = (key: ReviewKey) =>
    fields.find((f) => f.key === key)?.value?.trim() ?? "";
  const valid = (key: ReviewKey) => {
    const field = fields.find((f) => f.key === key);
    return (
      !!field?.value &&
      !field.conflict &&
      !validate(key, normalize(key, field.value))
    );
  };
  const nameReady = valid("fullName");
  const cpfReady = valid("cpf");
  const cnhReady = valid("cnh");
  const identifierReady = cpfReady || cnhReady;
  const requiredReady = documents.length > 0 && nameReady && identifierReady;
  const identificationReady = cpfReady && valid("fatherName") && cnhReady;
  // Everything settled in the review travels to the filling, optional or not.
  // Only fields still in conflict stay behind, waiting for the employee to pick.
  const carried = fields.filter((f) => !f.conflict && f.value.trim());
  const neededCount = (nameReady ? 1 : 0) + (identifierReady ? 1 : 0);
  // Optional conflicting fields are left out of the automation until the employee
  // chooses a value. Required identity conflicts still block the start action.
  const blockingConflicts = fields.filter(
    (f) => f.conflict && ["fullName", "cpf", "cnh"].includes(f.key),
  ).length;
  const currentStep = AUTOMATION_STEPS.findIndex((s) =>
    s.phases.includes(automation.phase),
  );
  const step = currentStep < 0 ? stoppedAt : currentStep;
  const stepState = (index: number) => {
    if (automation.phase === "done" || index < step) return "done";
    if (index > step) return "pending";
    if (automation.phase === "error") return "error";
    if (automation.phase === "cancelled") return "stopped";
    return "current";
  };
  const running = [
    "opening",
    "waiting",
    "cpf",
    "identification",
    "final",
  ].includes(automation.phase);
  const locked = busy || running;
  const hasOperation = documents.length > 0 || Object.keys(edits).length > 0;
  useEffect(() => {
    if (currentStep >= 0) setStoppedAt(currentStep);
  }, [currentStep]);
  useEffect(() => {
    const off = api?.onProgress(setProgress);
    const offAutomation = api?.onAutomation(setAutomation);
    const offUpdate = api?.onUpdate(setUpdate);
    return () => {
      off?.();
      offAutomation?.();
      offUpdate?.();
    };
  }, []);
  useEffect(() => {
    setPage(0);
    setZoom(1);
    setHighlight(undefined);
  }, [selectedId]);
  function change(key: ReviewKey, value: string) {
    setEdits((old) => ({ ...old, [key]: value }));
    setRecheckEdits((old) => old.filter((k) => k !== key));
    setConfirmed(false);
  }
  async function processInputs(inputs: DocumentInput[]) {
    if (!inputs.length || busyRef.current || running) return;
    if (documents.length + inputs.length > 10) {
      setErrors(["Adicione até 10 documentos por operação."]);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setConfirmed(false);
    cancelled.current = false;
    setErrors([]);
    try {
      for (const input of inputs) {
        if (cancelled.current) break;
        setReadingName(input.name);
        setProgress({
          documentId: input.id,
          progress: 0,
          phase: "Preparando documento",
        });
        try {
          const result = await api!.analyze(input);
          if (cancelled.current) break;
          setDocuments((old) => [...old, result]);
          setSelectedId(result.id);
          // Keep manual work; a new contradictory source requires a fresh explicit choice.
          setRecheckEdits((old) => [
            ...new Set([
              ...old,
              ...result.candidates
                .filter(
                  (c) =>
                    edits[c.key] !== undefined &&
                    fold(normalize(c.key, edits[c.key]!)) !== fold(c.value),
                )
                .map((c) => c.key),
            ]),
          ]);
        } catch (error) {
          if (!cancelled.current)
            setErrors((old) => [
              ...old,
              `${input.name}: ${errorMessage(error)}`,
            ]);
        }
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      setProgress(undefined);
    }
  }
  async function pick() {
    if (!api) {
      setErrors([
        "Abra o aplicativo CCA no Windows para selecionar documentos.",
      ]);
      return;
    }
    try {
      await processInputs(await api.pickDocuments());
    } catch (error) {
      setErrors([errorMessage(error)]);
    }
  }
  async function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (locked || !api) return;
    try {
      await processInputs(
        await Promise.all(
          [...event.dataTransfer.files].map((f) => api.readDroppedFile(f)),
        ),
      );
    } catch (error) {
      setErrors([errorMessage(error)]);
    }
  }
  async function cancelReading() {
    cancelled.current = true;
    await api?.cancelOcr();
  }
  function reset() {
    setDocuments([]);
    setEdits({});
    setRecheckEdits([]);
    setSelectedId("");
    setPage(0);
    setConfirmed(false);
    setErrors([]);
    setExpanded(false);
    setRaw(false);
    setResetOpen(false);
    setAutomation({ phase: "idle", message: "" });
    setAutomationOpen(false);
    setStoppedAt(0);
  }
  function remove(id: string) {
    setDocuments((old) => old.filter((d) => d.id !== id));
    setEdits({});
    setRecheckEdits([]);
    setConfirmed(false);
    setHighlight(undefined);
    if (id === selectedId)
      setSelectedId(documents.find((d) => d.id !== id)?.id ?? "");
  }
  async function start() {
    if (!confirmed || !requiredReady || blockingConflicts || locked) return;
    setAutomationOpen(true);
    setStoppedAt(0);
    setAutomation({
      phase: "opening",
      message: "Preparando o cadastro assistido.",
    });
    const optionalValue = (key: ReviewKey) => {
      const field = fields.find((f) => f.key === key);
      return field &&
        !field.conflict &&
        field.value &&
        !validate(key, normalize(key, field.value))
        ? normalize(key, field.value)
        : "";
    };
    try {
      await api!.startAutomation({
        fullName: valueOf("fullName"),
        cpf: optionalValue("cpf"),
        nome_pai_validacao: optionalValue("fatherName"),
        numero_cnh: optionalValue("cnh"),
        confirmed,
        // Everything the review settled goes along, optional fields included.
        // Only what is still in conflict stays behind: there the employee has
        // not chosen a value yet, and guessing one is worse than omitting it.
        reviewed: carried.map((field) => ({
          key: field.key,
          label: field.label,
          value: normalize(field.key, field.value),
        })),
      });
    } catch (error) {
      setAutomation({ phase: "error", message: errorMessage(error) });
    }
  }
  async function retryAutomation() {
    setStoppedAt(0);
    setAutomation({
      phase: "opening",
      message: "Reabrindo o navegador para o cadastro assistido.",
    });
    try {
      await api!.retryAutomation();
    } catch (error) {
      setAutomation({
        phase: "error",
        recovery: "browser",
        message: errorMessage(error),
      });
    }
  }
  async function downloadUpdate() {
    try {
      await api?.downloadUpdate();
    } catch (error) {
      setErrors([errorMessage(error)]);
    }
  }
  async function installUpdate() {
    try {
      await api?.installUpdate();
    } catch (error) {
      setErrors([errorMessage(error)]);
    }
  }
  function showSource(source?: Candidate) {
    if (!source) return;
    setSelectedId(source.documentId);
    setTimeout(() => {
      setPage(source.page - 1);
      setHighlight(source);
    }, 0);
  }
  function renderField(field: ReviewField) {
    const invalid = validate(field.key, normalize(field.key, field.value));
    const missing = !field.value && !field.conflict;
    const uncertain =
      field.note ||
      field.candidates.some(
        (c) => c.confidence !== undefined && c.confidence < 0.82,
      );
    const priority = ["fullName", "cpf", "cnh"].includes(field.key);
    return (
      <div
        className={`field ${field.conflict || invalid ? "field-warning" : ""}`}
        key={field.key}
      >
        <div className="field-label">
          <label htmlFor={`field-${field.key}`}>{field.label}</label>
          {priority && (
            <span className="required-tag">
              {field.key === "fullName" ? "Obrigatório" : "CPF ou CNH"}
            </span>
          )}
        </div>
        <div className="input-wrap">
          <input
            id={`field-${field.key}`}
            value={field.value}
            disabled={locked}
            placeholder={
              missing
                ? "Não encontrado neste documento"
                : "Selecione um valor ou corrija"
            }
            onChange={(event) => change(field.key, event.target.value)}
            onBlur={() => {
              const value = normalize(field.key, field.value);
              if (value !== field.value) change(field.key, value);
            }}
            onFocus={() => showSource(field.candidates[0])}
            autoComplete="off"
            spellCheck={false}
          />
          {field.value && !invalid && !field.conflict && (
            <Check size={16} className="input-check" />
          )}
        </div>
        {field.conflict && (
          <div className="conflict">
            <p>
              <TriangleAlert size={14} /> Os documentos apresentam valores
              diferentes.
            </p>
            {field.candidates
              .filter(
                (c, i, all) => all.findIndex((a) => a.value === c.value) === i,
              )
              .map((c) => (
                <button
                  disabled={locked}
                  key={`${c.documentId}-${c.value}`}
                  onClick={() => {
                    change(field.key, c.value);
                    showSource(c);
                  }}
                >
                  <span>
                    {c.value}
                    <small>
                      {c.documentName} · pág. {c.page}
                    </small>
                  </span>
                  <Check size={15} />
                </button>
              ))}
            <small>Escolha uma opção ou digite o valor correto acima.</small>
          </div>
        )}
        {invalid ? (
          <span className="field-hint warning-text">
            <TriangleAlert size={13} />
            {invalid}
          </span>
        ) : missing ? (
          <button
            className="field-hint text-button"
            disabled={locked}
            onClick={() =>
              document.getElementById(`field-${field.key}`)?.focus()
            }
          >
            <Plus size={13} />
            Digitar manualmente
          </button>
        ) : (
          <span
            className={`field-hint ${uncertain && !field.edited ? "warning-text" : ""}`}
          >
            {field.edited ? (
              <>
                <CheckCheck size={13} />
                Conferido por você
              </>
            ) : uncertain ? (
              <>
                <TriangleAlert size={13} />
                {field.note ?? "Confira esta informação no documento."}
              </>
            ) : (
              <>
                <Check size={13} />
                Identificado
                {field.candidates[0]
                  ? ` · página ${field.candidates[0].page}`
                  : ""}
              </>
            )}
          </span>
        )}
      </div>
    );
  }
  return (
    <div
      className="app-shell"
      onDragOver={(event) => {
        event.preventDefault();
        if (!locked) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          setDragging(false);
      }}
      onDrop={drop}
    >
      <header className="app-header">
        <div className="brand">
          <img src="./icon.png" alt="Ícone CCA" />
          <div>
            <span className="brand-name">
              CCA
              <span className="brand-divider" />
              Documentos
            </span>
            <small>CADASTRO ASSISTIDO · CAIXA AQUI</small>
          </div>
        </div>
        <div className="header-actions">
          <span className="local-badge">
            <span />
            Processamento local
          </span>
          <button
            className="icon-button help-button"
            title="Como funciona"
            aria-label="Como funciona"
            onClick={() => setHelp(true)}
          >
            <CircleHelp size={20} />
          </button>
        </div>
      </header>
      {update.phase !== "idle" &&
        update.phase !== "checking" &&
        update.phase !== "error" && (
          <div className={`update-toast ${update.phase}`} role="status">
            <div className="update-toast-icon">
              {update.phase === "downloading" ||
              update.phase === "installing" ? (
                <RefreshCw size={18} className="spin" />
              ) : (
                <Download size={18} />
              )}
            </div>
            <div className="update-toast-copy">
              <strong>
                {update.phase === "ready"
                  ? "Atualização pronta"
                  : update.phase === "installing"
                    ? "Instalando atualização"
                    : "Nova versão disponível"}
              </strong>
              <p>
                {update.phase === "available"
                  ? `A versão ${update.version} do CCA está disponível.`
                  : update.message}
              </p>
            </div>
            {update.phase === "available" && (
              <button
                className="button update-toast-button"
                onClick={() => void downloadUpdate()}
              >
                Baixar
              </button>
            )}
            {update.phase === "downloading" && (
              <span className="update-toast-progress">
                {update.progress ?? 0}%
              </span>
            )}
            {update.phase === "ready" && (
              <button
                className="button update-toast-button ready"
                onClick={() => void installUpdate()}
              >
                Instalar
              </button>
            )}
          </div>
        )}
      <nav className="steps" aria-label="Etapas do cadastro">
        {[
          { label: "Selecionar documento", n: 1 },
          { label: "Conferir dados", n: 2 },
          { label: "Iniciar cadastro", n: 3 },
        ].map((step, i) => (
          <div
            key={step.n}
            className={`step ${(hasOperation ? 2 : 1) === step.n ? "step-active" : ""} ${hasOperation && i === 0 ? "step-complete" : ""}`}
          >
            <span>
              {hasOperation && i === 0 ? <Check size={14} /> : step.n}
            </span>
            {step.label}
            {i < 2 && <i />}
          </div>
        ))}
      </nav>
      <main>
        {errors.length > 0 && (
          <div className="notice error-notice" role="alert">
            <TriangleAlert size={20} />
            <div>
              {errors.map((error, i) => (
                <p key={i}>{error}</p>
              ))}
            </div>
            <button
              className="icon-button"
              aria-label="Fechar aviso"
              onClick={() => setErrors([])}
            >
              <X size={17} />
            </button>
          </div>
        )}
        {!hasOperation && !busy ? (
          <section className="welcome">
            <span className="eyebrow">
              MENOS DIGITAÇÃO. MAIS ATENÇÃO AO CLIENTE. · v0.2.5
            </span>
            <h1>
              O cadastro começa
              <br />
              com um documento.
            </h1>
            <p>
              Importe os documentos do cliente. O CCA identifica os dados
              <br className="wide-only" /> para você conferir e seguir com o
              cadastro.
            </p>
            <div className={`upload-zone ${dragging ? "drag-active" : ""}`}>
              <div className="upload-illustration">
                <ScanLine size={78} strokeWidth={1} />
                <FileText size={39} strokeWidth={1.4} />
                <span>
                  <Check size={15} />
                </span>
              </div>
              <h2>Arraste um documento até aqui</h2>
              <p>ou selecione um arquivo do computador</p>
              <button className="button primary-button" onClick={pick}>
                <Upload size={17} />
                Selecionar documento
                <ArrowRight size={17} />
              </button>
              <small>PDF, JPG ou PNG · até 25 MB por arquivo</small>
            </div>
            <div className="welcome-features">
              <span>
                <FileScan size={21} />
                <span>
                  <b>Documentos variados</b>
                  <small>CNH, identidade, certidões e outros</small>
                </span>
              </span>
              <span>
                <ShieldCheck size={21} />
                <span>
                  <b>Você confere e confirma</b>
                  <small>Todos os dados podem ser corrigidos</small>
                </span>
              </span>
              <span>
                <LockKeyhole size={21} />
                <span>
                  <b>Leitura no seu computador</b>
                  <small>Sem envio de documentos à nuvem</small>
                </span>
              </span>
            </div>
          </section>
        ) : (
          <>
            <div className="page-heading">
              <div>
                <span className="eyebrow">DOCUMENTOS DO CLIENTE</span>
                <h1>
                  {busy && !documents.length
                    ? "Lendo seu documento"
                    : "Confira antes de continuar"}
                </h1>
                <p>
                  {busy && !documents.length
                    ? "Estamos localizando as informações para você."
                    : "Compare os dados com o documento e ajuste o que for necessário."}
                </p>
              </div>
              <button
                className="button secondary-button"
                onClick={pick}
                disabled={locked}
              >
                <FilePlus2 size={17} />
                Adicionar documento
              </button>
            </div>
            {busy && (
              <div className="reading-strip" role="status">
                <LoaderCircle size={22} className="spin" />
                <div>
                  <strong>{progress?.phase ?? "Preparando a leitura"}</strong>
                  <small>{readingName}</small>
                </div>
                <div className="progress-track">
                  <span
                    style={{
                      width: `${Math.max(3, (progress?.progress ?? 0) * 100)}%`,
                    }}
                  />
                </div>
                <button className="text-button" onClick={cancelReading}>
                  Cancelar leitura
                </button>
              </div>
            )}
            <div className="review-grid">
              <section
                className="document-panel"
                aria-label="Visualização do documento"
              >
                <div className="panel-top">
                  <div>
                    <FileText size={17} />
                    <b>Documento original</b>
                    <span className="count-badge">{documents.length}</span>
                  </div>
                  <button
                    className={`icon-button ${raw ? "active" : ""}`}
                    title={raw ? "Ver documento" : "Ver texto encontrado"}
                    aria-label={raw ? "Ver documento" : "Ver texto encontrado"}
                    onClick={() => setRaw(!raw)}
                  >
                    <ScanLine size={18} />
                  </button>
                </div>
                <div className="document-tabs">
                  {documents.map((doc, index) => (
                    <button
                      key={doc.id}
                      className={selected?.id === doc.id ? "selected" : ""}
                      title={doc.name}
                      onClick={() => setSelectedId(doc.id)}
                    >
                      <FileText size={14} />
                      {doc.type === "Documento não identificado"
                        ? `Documento ${index + 1}`
                        : doc.type}
                    </button>
                  ))}
                </div>
                <div className="document-meta">
                  <span title={selected?.name}>
                    {selected?.name ?? "Preparando visualização…"}
                  </span>
                  {selected && (
                    <button
                      className="icon-button"
                      disabled={locked}
                      aria-label="Remover documento"
                      title="Remover documento"
                      onClick={() => remove(selected.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
                <div className="preview-canvas">
                  {raw ? (
                    <pre className="raw-text">
                      {selected?.ocr.text ||
                        "Nenhum texto legível encontrado. Você pode digitar os dados ou adicionar outro documento."}
                    </pre>
                  ) : selectedPage ? (
                    <div
                      className="preview-paper"
                      style={{ width: `${zoom * 88}%` }}
                    >
                      <img
                        src={selectedPage.preview}
                        alt={`Página ${page + 1} de ${selected?.name}`}
                      />
                      {highlight?.documentId === selected?.id &&
                        highlight.page === page + 1 && (
                          <div
                            className="source-highlight"
                            style={{
                              left: `${(highlight.box.x / selectedPage.width) * 100}%`,
                              top: `${(highlight.box.y / selectedPage.height) * 100}%`,
                              width: `${(highlight.box.width / selectedPage.width) * 100}%`,
                              height: `${(highlight.box.height / selectedPage.height) * 100}%`,
                            }}
                          />
                        )}
                    </div>
                  ) : (
                    <div className="preview-placeholder">
                      <FileScan size={54} strokeWidth={1} />
                      <span>O documento aparecerá aqui</span>
                    </div>
                  )}
                </div>
                <div className="preview-toolbar">
                  <div>
                    <button
                      className="icon-button"
                      aria-label="Página anterior"
                      disabled={page === 0}
                      onClick={() => {
                        setPage(page - 1);
                        setHighlight(undefined);
                      }}
                    >
                      <ChevronLeft size={17} />
                    </button>
                    <span>
                      {selected
                        ? `${page + 1} de ${selected.ocr.pages.length}`
                        : "—"}
                    </span>
                    <button
                      className="icon-button"
                      aria-label="Próxima página"
                      disabled={
                        !selected || page >= selected.ocr.pages.length - 1
                      }
                      onClick={() => {
                        setPage(page + 1);
                        setHighlight(undefined);
                      }}
                    >
                      <ChevronRight size={17} />
                    </button>
                  </div>
                  <div>
                    <button
                      className="icon-button"
                      aria-label="Diminuir zoom"
                      disabled={zoom <= 0.75}
                      onClick={() => setZoom(Math.max(0.75, zoom - 0.25))}
                    >
                      <ZoomOut size={17} />
                    </button>
                    <span>{Math.round(zoom * 100)}%</span>
                    <button
                      className="icon-button"
                      aria-label="Aumentar zoom"
                      disabled={zoom >= 2}
                      onClick={() => setZoom(Math.min(2, zoom + 0.25))}
                    >
                      <ZoomIn size={17} />
                    </button>
                  </div>
                </div>
                <div className="document-tip">
                  <Info size={14} />
                  <span>
                    Selecione um campo para localizar a informação no documento.
                  </span>
                </div>
              </section>
              <section className="data-panel" aria-label="Dados identificados">
                <div className="panel-top">
                  <div>
                    <Fingerprint size={19} />
                    <b>Dados identificados</b>
                  </div>
                  <span className="suggestion-tag">Conferência</span>
                </div>
                <div className="data-body">
                  <div
                    className={`classification ${selected?.typeConfidence ? "" : "unknown"}`}
                  >
                    <div className="classification-icon">
                      <FileScan size={21} />
                    </div>
                    <div>
                      <small>
                        {selected?.typeConfidence
                          ? "DOCUMENTO IDENTIFICADO"
                          : "TIPO NÃO IDENTIFICADO COM SEGURANÇA"}
                      </small>
                      <b>
                        {selected?.typeConfidence
                          ? selected.type
                          : "Os dados encontrados podem ser conferidos."}
                      </b>
                    </div>
                    {!!selected?.typeConfidence && <Check size={17} />}
                  </div>
                  {conflicts > 0 && (
                    <div className="notice conflict-notice" role="alert">
                      <TriangleAlert size={18} />
                      <span>
                        {conflicts}{" "}
                        {conflicts === 1
                          ? "campo apresenta divergência"
                          : "campos apresentam divergências"}
                        .{" "}
                        {blockingConflicts
                          ? "Resolva os dados principais para continuar."
                          : "Confira os campos opcionais ou escolha um valor antes de enviá-los."}
                      </span>
                    </div>
                  )}
                  <div className="required-summary">
                    <span>DADOS NECESSÁRIOS PARA O CADASTRO</span>
                    <b>{neededCount} de 2</b>
                    <div>
                      <span className={nameReady ? "ready" : ""}>
                        {nameReady ? (
                          <Check size={13} />
                        ) : (
                          <span className="empty-dot" />
                        )}
                        Nome
                      </span>
                      <span className={identifierReady ? "ready" : ""}>
                        {identifierReady ? (
                          <Check size={13} />
                        ) : (
                          <span className="empty-dot" />
                        )}
                        CPF ou CNH
                      </span>
                    </div>
                  </div>
                  <div className="primary-fields">
                    {PRIMARY.map((key) => fields.find((f) => f.key === key))
                      .filter((f): f is ReviewField => !!f)
                      .map(renderField)}
                  </div>
                  <button
                    className="other-data-toggle"
                    onClick={() => setExpanded(!expanded)}
                    aria-expanded={expanded}
                  >
                    <span>
                      <Plus size={16} />
                      Outros dados encontrados{" "}
                      <span className="count-badge">
                        {
                          fields.filter(
                            (f) =>
                              !PRIMARY.includes(f.key as never) &&
                              (f.value || f.conflict),
                          ).length
                        }
                      </span>
                    </span>
                    <ChevronDown
                      size={17}
                      className={expanded ? "rotated" : ""}
                    />
                  </button>
                  {expanded && (
                    <div className="other-fields">
                      {fields
                        .filter((f) => !PRIMARY.includes(f.key as never))
                        .map(renderField)}
                      <details className="add-manual-fields">
                        <summary>Adicionar um campo ausente</summary>
                        <div>
                          {Object.entries(FIELD_LABELS)
                            .filter(
                              ([key]) => !fields.some((f) => f.key === key),
                            )
                            .map(([key, label]) => (
                              <button
                                key={key}
                                disabled={locked}
                                className="text-button"
                                onClick={() => change(key as ReviewKey, "")}
                              >
                                <Plus size={12} />
                                {label}
                              </button>
                            ))}
                        </div>
                      </details>
                    </div>
                  )}
                  <div className="review-confirm">
                    <label>
                      <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(event) => setConfirmed(event.target.checked)}
                        disabled={
                          locked || !requiredReady || blockingConflicts > 0
                        }
                      />
                      <span>
                        Conferi os dados e confirmo que os documentos pertencem
                        ao mesmo cliente.
                      </span>
                    </label>
                    {requiredReady &&
                      !blockingConflicts &&
                      !identificationReady &&
                      automation.phase !== "done" && (
                        <div className="notice hint-notice">
                          <Info size={17} />
                          <p>
                            A identificação positiva do CAIXA Aqui usa{" "}
                            <b>CPF</b>, <b>nome do pai</b> e{" "}
                            <b>número da CNH</b> juntos. Sem algum deles a
                            consulta pode ser recusada — dá para iniciar assim
                            mesmo e completar se isso acontecer.
                          </p>
                        </div>
                      )}
                    {automation.phase === "done" ? (
                      // The run is over but the operation is not: the employee
                      // is still filling the CAIXA Aqui screen. Starting another
                      // one from here would pull the browser out from under
                      // them, so the button becomes the way out of the
                      // operation instead.
                      <button
                        className="button primary-button start-button"
                        onClick={() => reset()}
                      >
                        Finalizei o cadastro
                        <Check size={18} />
                      </button>
                    ) : (
                      <button
                        className="button primary-button start-button"
                        onClick={start}
                        disabled={
                          !confirmed ||
                          !requiredReady ||
                          !!blockingConflicts ||
                          locked
                        }
                      >
                        Iniciar cadastro
                        <ArrowUpRight size={18} />
                      </button>
                    )}
                    <p>
                      <LockKeyhole size={12} />
                      {automation.phase === "done"
                        ? "Conclua e salve no CAIXA Aqui antes de começar a próxima operação."
                        : !requiredReady
                          ? "Informe o nome e um CPF ou CNH válidos para continuar."
                          : blockingConflicts
                            ? "Resolva as divergências dos dados principais para continuar."
                            : `${
                                carried.length === 1
                                  ? "1 campo conferido segue"
                                  : `${carried.length} campos conferidos seguem`
                              } para o preenchimento. O CCA para na tela cadastral final.`}
                    </p>
                  </div>
                </div>
              </section>
            </div>
            <div className="operation-footer">
              <span>
                <ShieldCheck size={15} />
                Seus documentos ficam nesta operação. Sem histórico de clientes.
              </span>
              <button
                className="text-button"
                disabled={locked}
                onClick={() => setResetOpen(true)}
              >
                <RotateCcw size={14} />
                Nova operação
              </button>
            </div>
          </>
        )}
      </main>
      <footer className="app-footer">
        <span>
          CCA <b>Documentos</b>
          <i />
          Da leitura à conferência.
        </span>
        <span>MVP · v0.2.5</span>
      </footer>
      {dragging && !locked && (
        <div className="drop-overlay">
          <Upload size={44} />
          <h2>Solte para adicionar à operação</h2>
          <span>PDF, JPG ou PNG</span>
        </div>
      )}
      {help && (
        <Modal title="Do documento ao cadastro" close={() => setHelp(false)}>
          <div className="help-steps">
            <p>
              <b>1. Importe</b>Escolha um documento legível. PDFs de até 15
              páginas e arquivos de até 25 MB são aceitos.
            </p>
            <p>
              <b>2. Confira</b>Compare as sugestões com o original. Adicione
              outro documento ou digite as informações ausentes. Filiação sem
              rótulos precisa de atenção à ordem dos nomes.
            </p>
            <p>
              <b>3. Continue no CAIXA Aqui</b>Confirme os dados. O Chrome será
              aberto para seu login habitual. Deixe a tela “CPF do Cliente”
              pronta e autorize o início.
            </p>
          </div>
          <div className="notice">
            <ShieldCheck size={20} />
            <p>
              A leitura acontece neste computador. Somente CPF, nome do pai e
              CNH alimentam o fluxo existente do CAIXA Aqui.
            </p>
          </div>
          <button
            className="button primary-button"
            onClick={() => setHelp(false)}
          >
            Entendi
            <Check size={16} />
          </button>
        </Modal>
      )}
      {resetOpen && (
        <Modal
          title="Começar uma nova operação?"
          close={() => setResetOpen(false)}
        >
          <p>
            Os documentos, correções e dados desta operação serão removidos da
            tela.
          </p>
          <div className="modal-actions">
            <button
              className="button secondary-button"
              onClick={() => setResetOpen(false)}
            >
              Continuar conferência
            </button>
            <button className="button primary-button" onClick={reset}>
              Nova operação
              <ArrowRight size={16} />
            </button>
          </div>
        </Modal>
      )}
      {automationOpen && (
        <Modal
          title={
            automation.phase === "done"
              ? "Chegamos à tela cadastral"
              : automation.phase === "error"
                ? "O cadastro assistido parou"
                : automation.phase === "cancelled"
                  ? "Operação interrompida"
                  : "Cadastro assistido"
          }
          close={running ? undefined : () => setAutomationOpen(false)}
        >
          {!running && (
            <div className={`automation-symbol ${automation.phase}`}>
              {automation.phase === "done" ? (
                <CheckCheck size={34} />
              ) : (
                <TriangleAlert size={34} />
              )}
            </div>
          )}
          <ol className="automation-steps">
            {AUTOMATION_STEPS.map((item, index) => (
              <li key={item.label} className={stepState(index)}>
                <span className="automation-step-mark">
                  {stepState(index) === "done" ? (
                    <Check size={13} />
                  ) : stepState(index) === "error" ? (
                    <TriangleAlert size={13} />
                  ) : stepState(index) !== "current" ? (
                    index + 1
                  ) : automation.phase === "waiting" ? (
                    <Fingerprint size={13} />
                  ) : (
                    <LoaderCircle size={13} className="spin" />
                  )}
                </span>
                {item.label}
              </li>
            ))}
          </ol>
          <p className="automation-message" role="status">
            {automation.message}
          </p>
          {automation.phase === "waiting" && (
            <>
              <div className="notice">
                <Info size={19} />
                <p>
                  Na janela do Chrome, faça login normalmente e abra{" "}
                  <b>CPF do Cliente</b>. Depois, confirme abaixo.
                </p>
              </div>
              <button
                className="button primary-button"
                onClick={async () => {
                  try {
                    await api?.continueAutomation();
                  } catch (error) {
                    setAutomation({
                      phase: "error",
                      recovery: "browser",
                      message: errorMessage(error),
                    });
                  }
                }}
              >
                Já estou na tela CPF do Cliente
                <ArrowRight size={17} />
              </button>
            </>
          )}
          {running && (
            <button
              className="text-button cancel-automation"
              onClick={() => api?.cancelAutomation()}
            >
              Interromper automação
            </button>
          )}
          {automation.phase === "done" && (
            <div className="modal-actions">
              <button
                className="button secondary-button"
                onClick={() => setAutomationOpen(false)}
              >
                Ainda estou no cadastro
              </button>
              <button
                className="button primary-button"
                onClick={() => reset()}
              >
                Finalizei o cadastro
                <Check size={16} />
              </button>
            </div>
          )}
          {(automation.phase === "error" ||
            automation.phase === "cancelled") && (
            <div className="modal-actions">
              {automation.recovery !== "data" && (
                <button
                  className="button secondary-button"
                  onClick={() => setAutomationOpen(false)}
                >
                  Voltar à conferência
                </button>
              )}
              {automation.recovery === "data" ? (
                <button
                  className="button primary-button"
                  onClick={() => setAutomationOpen(false)}
                >
                  Voltar e completar
                  <ArrowRight size={16} />
                </button>
              ) : (
                <button
                  className="button primary-button"
                  onClick={retryAutomation}
                >
                  Tentar de novo
                  <RotateCcw size={16} />
                </button>
              )}
            </div>
          )}
          <small className="automation-footnote">
            {automation.phase === "done"
              ? "O CCA não salva nem conclui o cadastro. Termine no CAIXA Aqui e volte aqui para começar a próxima operação."
              : "O preenchimento já feito permanece no Chrome. O CCA não salva nem conclui o cadastro final."}
          </small>
        </Modal>
      )}
    </div>
  );
}
function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: React.ReactNode;
  close?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      className="modal"
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        close?.();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        {close && (
          <button className="icon-button" onClick={close} aria-label="Fechar">
            <X size={19} />
          </button>
        )}
      </div>
      {children}
    </dialog>
  );
}
