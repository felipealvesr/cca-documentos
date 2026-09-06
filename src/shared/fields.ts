import type { FieldKey } from "./types";
export const FIELD_LABELS: Record<FieldKey, string> = {
  fullName: "Nome completo",
  socialName: "Nome social",
  cpf: "CPF",
  rg: "RG",
  cin: "CIN",
  cnh: "Número da CNH",
  passport: "Passaporte",
  birthDate: "Data de nascimento",
  birthPlace: "Naturalidade",
  nationality: "Nacionalidade",
  fatherName: "Nome do pai",
  motherName: "Nome da mãe",
  gender: "Sexo / gênero",
  maritalStatus: "Estado civil",
  issuingAuthority: "Órgão emissor",
  issuingState: "UF de emissão",
  issueDate: "Data de emissão",
  expirationDate: "Validade",
  "address.street": "Logradouro",
  "address.number": "Número do endereço",
  "address.complement": "Complemento",
  "address.neighborhood": "Bairro",
  "address.city": "Cidade",
  "address.state": "UF do endereço",
  "address.postalCode": "CEP",
};
export const PRIORITY: FieldKey[] = ["cpf", "fatherName", "cnh"];
export const PRIMARY: FieldKey[] = [
  "fullName",
  "cpf",
  "birthDate",
  "fatherName",
  "cnh",
];
export const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
export const digits = (value: string) => value.replace(/\D/g, "");
export function normalize(key: string, value: string): string {
  const clean = value
    .replace(/^[\s:;|–—]+|[\s;|]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (key === "cpf" || key === "cin") {
    const n = digits(clean);
    return n.length === 11
      ? n.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4")
      : clean;
  }
  if (key === "cnh") return /^[\d.\s-]+$/.test(clean) ? digits(clean) : clean;
  if (key === "address.postalCode") {
    const n = digits(clean);
    return n.length === 8 ? n.replace(/(\d{5})(\d{3})/, "$1-$2") : clean;
  }
  if (key.endsWith("Date"))
    return clean
      .replace(/^(\d{2})(\d{2})(\d{4})$/, "$1/$2/$3")
      .replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$3/$2/$1")
      .replace(
        /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/,
        (_, d, m, y) => `${d.padStart(2, "0")}/${m.padStart(2, "0")}/${y}`,
      );
  if (key === "issuingState" || key === "address.state") {
    const names = [
      "Acre",
      "Alagoas",
      "Amapá",
      "Amazonas",
      "Bahia",
      "Ceará",
      "Distrito Federal",
      "Espírito Santo",
      "Goiás",
      "Maranhão",
      "Mato Grosso",
      "Mato Grosso do Sul",
      "Minas Gerais",
      "Pará",
      "Paraíba",
      "Paraná",
      "Pernambuco",
      "Piauí",
      "Rio de Janeiro",
      "Rio Grande do Norte",
      "Rio Grande do Sul",
      "Rondônia",
      "Roraima",
      "Santa Catarina",
      "São Paulo",
      "Sergipe",
      "Tocantins",
    ];
    const states =
      "AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(
        " ",
      );
    return (
      states[names.findIndex((name) => fold(name) === fold(clean))] ??
      clean.toUpperCase()
    );
  }
  return clean;
}
export function validate(key: string, value: string): string | undefined {
  if (!value.trim()) return undefined;
  if (key === "cpf" || key === "cin") {
    if (!/^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/.test(value))
      return "Confira o CPF: são necessários 11 dígitos.";
    const n = digits(value);
    if (/^(\d)\1{10}$/.test(n))
      return "Os dígitos verificadores do CPF não conferem.";
    for (let len = 9; len <= 10; len++) {
      const sum = [...n.slice(0, len)].reduce(
        (s, d, i) => s + Number(d) * (len + 1 - i),
        0,
      );
      const check = (sum * 10) % 11;
      if ((check === 10 ? 0 : check) !== Number(n[len]))
        return "Os dígitos verificadores do CPF não conferem.";
    }
  }
  if (key.endsWith("Date")) {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
    if (!match) return "Use uma data válida no formato DD/MM/AAAA.";
    const [, d, m, y] = match.map(Number),
      date = new Date(y, m - 1, d);
    if (
      y < 1800 ||
      date.getFullYear() !== y ||
      date.getMonth() !== m - 1 ||
      date.getDate() !== d
    )
      return "Esta data não é válida.";
    if (key === "birthDate" && date > new Date())
      return "A data de nascimento está no futuro.";
  }
  if (key === "address.postalCode" && !/^\d{5}-?\d{3}$/.test(value))
    return "O CEP deve conter 8 dígitos.";
  if (
    ["issuingState", "address.state"].includes(key) &&
    !"AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO"
      .split(" ")
      .includes(value)
  )
    return "Confira a sigla da UF.";
  if (key === "cnh" && !/^\d{11}$/.test(value))
    return "A CNH deve conter 11 dígitos.";
  if (key === "fatherName" && !/[A-Za-zÀ-ÿ]{2}/.test(value))
    return "Confira o nome do pai.";
  return undefined;
}
