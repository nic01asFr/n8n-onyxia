// État du portail : propriétaire, actions exposées, accès ouverts.
//
// Un fichier JSON sur le volume de n8n suffit : quelques dizaines d'actions,
// écrites rarement, par une seule personne. L'écriture passe par un fichier
// temporaire renommé, pour qu'un arrêt du pod ne laisse jamais un état à moitié
// écrit, et les écritures sont mises en file pour ne jamais se chevaucher.
//
// C'est ici que vivent les droits. Un document Grist peut en afficher une copie,
// jamais la modifier : un éditeur du document ne doit pas pouvoir s'ouvrir une
// action que le propriétaire n'a pas ouverte.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const VERSION = 1;
const ACTION_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function emptyState() {
  return { version: VERSION, owner: null, actions: {}, access: {} };
}

// La clé d'accès réunit l'hôte Grist et le document : deux instances Grist
// peuvent produire le même identifiant de document.
export function accessKey(origin, docId) {
  return `${origin}#${docId}`;
}

export function isActionKey(key) {
  return ACTION_KEY.test(String(key || ""));
}

export async function openStore(file) {
  let state = emptyState();
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed && parsed.version === VERSION) state = { ...emptyState(), ...parsed };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let queue = Promise.resolve();
  function persist() {
    const snapshot = JSON.stringify(state, null, 2);
    queue = queue.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, file);
    });
    return queue;
  }

  return {
    owner() {
      return state.owner;
    },

    async pairOwner({ origin, userId }) {
      if (state.owner && (state.owner.origin !== origin || state.owner.userId !== userId)) {
        return false;
      }
      if (!state.owner) {
        state.owner = { origin, userId, pairedAt: new Date().toISOString() };
        await persist();
      }
      return true;
    },

    isOwner(identity) {
      return Boolean(
        state.owner && identity &&
        state.owner.origin === identity.origin && state.owner.userId === identity.userId,
      );
    },

    actions() {
      return { ...state.actions };
    },

    action(key) {
      return state.actions[key] ?? null;
    },

    async putAction(key, action) {
      if (!isActionKey(key)) throw new Error(`Clé d'action invalide : ${key}`);
      state.actions[key] = { ...action, updatedAt: new Date().toISOString() };
      await persist();
      return state.actions[key];
    },

    async deleteAction(key) {
      if (!state.actions[key]) return false;
      delete state.actions[key];
      for (const entry of Object.values(state.access)) {
        entry.actions = entry.actions.filter((k) => k !== key);
      }
      await persist();
      return true;
    },

    access(origin, docId) {
      return state.access[accessKey(origin, docId)] ?? null;
    },

    allAccess() {
      return Object.values(state.access);
    },

    async setAccess({ origin, docId, label = "", actions }) {
      const known = actions.filter((key) => state.actions[key]);
      const k = accessKey(origin, docId);
      if (known.length === 0) {
        delete state.access[k];
      } else {
        state.access[k] = { kind: "grist-doc", origin, docId, label, actions: known, updatedAt: new Date().toISOString() };
      }
      await persist();
      return state.access[k] ?? null;
    },

    flush() {
      return queue;
    },
  };
}
