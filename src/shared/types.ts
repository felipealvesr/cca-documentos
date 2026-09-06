export interface ExtractedField {
  label: string;
  value: string;
  confidence?: number;
  sourcePage?: number;
  boundingBox?: Box;
}
export interface ExtractedPersonData {
  documentType?: string;
  fullName?: string;
  socialName?: string;
  cpf?: string;
  rg?: string;
  cin?: string;
  cnh?: string;
  passport?: string;
  birthDate?: string;
  birthPlace?: string;
  nationality?: string;
  fatherName?: string;
  motherName?: string;
  gender?: string;
  maritalStatus?: string;
  issuingAuthority?: string;
  issuingState?: string;
  issueDate?: string;
  expirationDate?: string;
  address?: {
    street?: string;
    number?: string;
    complement?: string;
    neighborhood?: string;
    city?: string;
    state?: string;
    postalCode?: string;
  };
  additionalFields?: ExtractedField[];
}
export type FieldKey =
  | Exclude<
      keyof ExtractedPersonData,
      "address" | "additionalFields" | "documentType"
    >
  | `address.${keyof NonNullable<ExtractedPersonData["address"]>}`;
export type ReviewKey = FieldKey | `additional:${string}`;
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface OcrElement {
  text: string;
  box: Box;
  confidence?: number;
  page: number;
}
export interface OcrPage {
  number: number;
  width: number;
  height: number;
  preview: string;
  method: "text" | "ocr";
  elements: OcrElement[];
  model?: "small" | "medium";
  initialElements?: OcrElement[];
  metrics?: {
    smallMs: number;
    mediumMs: number;
    fallbackUsed: boolean;
    orientationRetried?: boolean;
    orientationDegrees?: number;
    reasons: string[];
    score: number;
  };
}
export interface OcrResult {
  text: string;
  pages: OcrPage[];
}
export interface DocumentInput {
  id: string;
  name: string;
  bytes: Uint8Array;
}
export interface Candidate {
  key: ReviewKey;
  label: string;
  value: string;
  confidence?: number;
  documentId: string;
  documentName: string;
  page: number;
  box: Box;
  note?: string;
}
export interface ProcessedDocument {
  id: string;
  name: string;
  type: string;
  typeConfidence: number;
  ocr: OcrResult;
  data: ExtractedPersonData;
  candidates: Candidate[];
}
export interface ReviewField {
  key: ReviewKey;
  label: string;
  value: string;
  candidates: Candidate[];
  conflict: boolean;
  edited: boolean;
  note?: string;
}
export interface Progress {
  documentId: string;
  phase: string;
  progress: number;
}
export type AutomationPhase =
  | "idle"
  | "opening"
  | "waiting"
  | "cpf"
  | "identification"
  | "final"
  | "done"
  | "error"
  | "cancelled";
export interface AutomationStatus {
  phase: AutomationPhase;
  message: string;
}
export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";
export interface AppUpdateStatus {
  phase: UpdatePhase;
  version?: string;
  progress?: number;
  message: string;
}
export interface AutomationInput {
  fullName: string;
  cpf?: string;
  nome_pai_validacao?: string;
  numero_cnh?: string;
  confirmed: boolean;
}
export interface DesktopApi {
  pickDocuments(): Promise<DocumentInput[]>;
  readDroppedFile(file: File): Promise<DocumentInput>;
  analyze(input: DocumentInput): Promise<ProcessedDocument>;
  cancelOcr(): Promise<void>;
  onProgress(callback: (progress: Progress) => void): () => void;
  startAutomation(input: AutomationInput): Promise<void>;
  continueAutomation(): Promise<void>;
  cancelAutomation(): Promise<void>;
  onAutomation(callback: (status: AutomationStatus) => void): () => void;
  checkForUpdate(): Promise<AppUpdateStatus>;
  downloadUpdate(): Promise<AppUpdateStatus>;
  installUpdate(): Promise<void>;
  onUpdate(callback: (status: AppUpdateStatus) => void): () => void;
}
declare global {
  interface Window {
    cca?: DesktopApi;
  }
}
