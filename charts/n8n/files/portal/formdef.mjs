// Formulaires des actions : le contrat FormDef de Widgets Grist
// (projects/grist_forms), étendu pour viser une action plutôt qu'une table.
//
// FormDef 1.0 décrit une saisie qui devient une ligne Grist (tableId,
// composeMode, colId = colonne). L'extension 1.1 proposée est additive :
//   target : { kind: "action", action: <clé> }  -> tableId et composeMode facultatifs,
//            colId devient le nom du champ envoyé au workflow ;
//   result : { fields: [{ key, label, render }] } -> ce qu'on affiche du retour.
// Le moteur de rendu (engine.js) reste celui de grist_forms, sans fourche.

export const FORMDEF_VERSION = "1.1.0";

const WIDGETS = new Set(["text", "textarea", "number", "checkbox", "date", "datetime", "select", "radio", "multiselect", "likert"]);
const TYPES = new Set(["Text", "Int", "Numeric", "Bool", "Date", "DateTime", "Choice", "ChoiceList"]);
const RENDERS = new Set(["badge", "text", "markdown", "link", "list", "number", "json", "datetime"]);
const FIELD_ID = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_TEXT = 20000;

const DEFAULT_WIDGET = {
  Text: "text", Int: "number", Numeric: "number", Bool: "checkbox",
  Date: "date", DateTime: "datetime", Choice: "select", ChoiceList: "multiselect",
};

const LONG_TEXT = /prompt|texte|text|description|contenu|content|message|query|question|consigne|instruction/i;

export function humanize(name) {
  const spaced = String(name).replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1).toLowerCase() : name;
}

// Liste des défauts d'un FormDef d'action, vide s'il est utilisable.
export function validateActionFormDef(formdef, key) {
  const errors = [];
  if (!formdef || typeof formdef !== "object") return ["Le formulaire doit être un objet JSON."];
  if (typeof formdef.title !== "string" || !formdef.title.trim()) errors.push("Titre manquant.");
  if (formdef.target?.kind !== "action") errors.push('target.kind doit valoir "action".');
  if (key && formdef.target?.action !== key) errors.push(`target.action doit valoir "${key}".`);
  if (!Array.isArray(formdef.sections) || formdef.sections.length === 0) errors.push("Au moins une section est requise.");
  const seen = new Set();
  for (const section of formdef.sections || []) {
    if (!section || typeof section.label !== "string") errors.push("Chaque section a besoin d'un libellé.");
    for (const field of section?.fields || []) {
      if (!FIELD_ID.test(field?.colId || "")) errors.push(`Identifiant de champ invalide : ${field?.colId}`);
      else if (seen.has(field.colId)) errors.push(`Champ en double : ${field.colId}`);
      seen.add(field?.colId);
      if (!TYPES.has(field?.type)) errors.push(`Type non pris en charge pour ${field?.colId} : ${field?.type}`);
      if (!WIDGETS.has(field?.widget)) errors.push(`Widget non pris en charge pour ${field?.colId} : ${field?.widget}`);
    }
  }
  for (const out of formdef.result?.fields || []) {
    if (!FIELD_ID.test(out?.key || "")) errors.push(`Clé de résultat invalide : ${out?.key}`);
    if (!RENDERS.has(out?.render)) errors.push(`Rendu inconnu pour ${out?.key} : ${out?.render}`);
  }
  return errors;
}

// Brouillon proposé au propriétaire : un champ par entrée repérée dans le
// workflow. Il l'ajuste ensuite ; rien n'est exposé tant qu'il n'a pas validé.
export function draftFormDef({ key, workflow, inputNames }) {
  const fields = inputNames.map((name) => {
    const widget = LONG_TEXT.test(name) ? "textarea" : "text";
    return { colId: name, label: humanize(name), type: "Text", widget, required: false, options: {} };
  });
  return {
    manifest_version: FORMDEF_VERSION,
    id: key,
    title: workflow?.name || humanize(key),
    description: "",
    target: { kind: "action", action: key },
    sections: [{ id: "saisie", label: "Votre demande", fields }],
    choices: {},
    result: { fields: [] },
  };
}

function isEmpty(value) {
  return value == null || value === "" || (Array.isArray(value) && value.length === 0);
}

function fromGristList(value) {
  // Le moteur code les listes à la manière de Grist : ["L", a, b].
  if (Array.isArray(value) && value[0] === "L") return value.slice(1);
  return Array.isArray(value) ? value : [value];
}

function choicesOf(formdef, field) {
  const key = field.options?.choicesKey || field.colId;
  const list = formdef.choices?.[key] ?? field.options?.choices;
  return Array.isArray(list) ? list.map((c) => (c && typeof c === "object" ? String(c.value) : String(c))) : null;
}

function convert(formdef, field, value) {
  switch (field.type) {
    case "Text": {
      const s = String(value);
      if (s.length > MAX_TEXT) throw new Error(`« ${field.label} » dépasse ${MAX_TEXT} caractères.`);
      return s;
    }
    case "Int":
    case "Numeric": {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`« ${field.label} » attend un nombre.`);
      return field.type === "Int" ? Math.trunc(n) : n;
    }
    case "Bool":
      return value === true || value === "true" || value === 1;
    case "Date":
    case "DateTime": {
      // Le moteur envoie des secondes Unix, comme Grist ; un workflow lit plus
      // volontiers une date ISO.
      const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
      if (!Number.isFinite(ms)) throw new Error(`« ${field.label} » attend une date.`);
      const iso = new Date(ms).toISOString();
      return field.type === "Date" ? iso.slice(0, 10) : iso;
    }
    case "Choice": {
      const s = String(value);
      const allowed = choicesOf(formdef, field);
      if (allowed && !allowed.includes(s)) throw new Error(`Valeur non proposée pour « ${field.label} ».`);
      return s;
    }
    case "ChoiceList": {
      const list = fromGristList(value).map(String);
      const allowed = choicesOf(formdef, field);
      if (allowed && list.some((s) => !allowed.includes(s))) throw new Error(`Valeur non proposée pour « ${field.label} ».`);
      return list;
    }
    default:
      throw new Error(`Type non pris en charge : ${field.type}`);
  }
}

// Contrôle serveur des entrées : seuls les champs déclarés passent, convertis
// et bornés. Les champs obligatoires sans condition d'affichage sont exigés ;
// ceux qui dépendent d'une condition l'ont été par le formulaire.
export function checkInputs(formdef, raw) {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  const missing = [];
  for (const section of formdef.sections || []) {
    const sectionConditional = Boolean(section.condition || section.gate);
    for (const field of section.fields || []) {
      const value = Object.prototype.hasOwnProperty.call(input, field.colId) ? input[field.colId] : undefined;
      if (isEmpty(value)) {
        if (field.required && !field.condition && !sectionConditional) missing.push(field.label || field.colId);
        continue;
      }
      out[field.colId] = convert(formdef, field, value);
    }
  }
  if (missing.length) throw new Error(`Champs obligatoires manquants : ${missing.join(", ")}.`);
  return out;
}

// Ce que le destinataire voit du retour : les clés déclarées, et seulement
// elles. Sans déclaration, le retour entier (choix du propriétaire).
export function pickResult(formdef, body) {
  const declared = formdef.result?.fields;
  if (!Array.isArray(declared) || declared.length === 0) return body;
  const out = {};
  for (const { key } of declared) if (Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  return out;
}

// Vue destinataire d'une action : le formulaire, sans rien de l'implémentation.
export function publicAction(key, action) {
  return {
    key,
    title: action.formdef.title,
    description: action.formdef.description || "",
    icon: action.icon || "",
    formdef: action.formdef,
  };
}
