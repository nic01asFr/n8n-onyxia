// Interface du portail, chargée comme widget personnalisé dans Grist.
//
// Deux usages :
//   Actions    : le lecteur voit les actions ouvertes dans ce document, remplit
//                le formulaire (moteur grist_forms) et lit le résultat ;
//   Configurer : le propriétaire, avec le jeton d'administration, choisit les
//                workflows exposés, règle leur formulaire et les ouvre ici.
//
// Aucune valeur venue d'un workflow, d'un formulaire ou du document n'est
// injectée en HTML : tout passe par textContent. Le moteur échappe lui-même ce
// qu'il rend.

(function () {
  'use strict';

  var ADMIN_KEY = 'portail-admin';
  var root = document.getElementById('app');
  var state = {
    token: null,
    tokenExp: 0,
    baseUrl: null,
    catalog: null,
    adminToken: readSession(ADMIN_KEY)
  };

  function readSession(key) {
    try { return window.sessionStorage.getItem(key) || ''; } catch (e) { return ''; }
  }

  function writeSession(key, value) {
    try {
      if (value) window.sessionStorage.setItem(key, value);
      else window.sessionStorage.removeItem(key);
    } catch (e) { /* stockage indisponible : le jeton reste en mémoire */ }
  }

  // ── Construction du DOM ──────────────────────────────────────────────────

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (name) {
      var value = attrs[name];
      if (value == null || value === false) return;
      if (name === 'text') el.textContent = value;
      else if (name === 'class') el.className = value;
      else if (name.indexOf('on') === 0) el.addEventListener(name.slice(2), value);
      else el.setAttribute(name, value === true ? '' : value);
    });
    [].concat(children == null ? [] : children).forEach(function (child) {
      if (child == null || child === false) return;
      el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return el;
  }

  function show() {
    var nodes = [].slice.call(arguments).filter(function (n) { return n != null && n !== false; });
    root.replaceChildren.apply(root, nodes);
    window.scrollTo(0, 0);
  }

  function alertBox(kind, message, details) {
    return h('div', { class: 'fr-alert fr-alert--' + kind, role: kind === 'error' ? 'alert' : 'status' }, [
      h('p', { text: message }),
      details && details.length ? h('ul', { class: 'portail__details' }, details.map(function (d) { return h('li', { text: d }); })) : null
    ]);
  }

  function button(label, onclick, variant, attrs) {
    var cls = 'fr-btn' + (variant ? ' fr-btn--' + variant : '');
    return h('button', Object.assign({ type: 'button', class: cls, text: label, onclick: onclick }, attrs || {}));
  }

  // ── Accès au portail ─────────────────────────────────────────────────────

  function gristAuth() {
    if (state.token && Date.now() < state.tokenExp) return Promise.resolve();
    // Lecture seule : le jeton ne sert qu'à prouver qui regarde, et depuis quel
    // document. Le portail ne s'en sert pas pour écrire.
    return window.grist.docApi.getAccessToken({ readOnly: true }).then(function (tk) {
      state.token = tk.token;
      state.baseUrl = tk.baseUrl;
      state.tokenExp = Date.now() + Math.max(30000, (tk.ttlMsecs || 300000) * 0.8);
    });
  }

  function api(method, path, body, admin) {
    return gristAuth().then(function () {
      var headers = { 'x-grist-token': state.token, 'x-grist-base': state.baseUrl };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (admin) headers.authorization = 'Bearer ' + state.adminToken;
      return fetch(path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) });
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (json) {
        if (!res.ok) {
          var error = new Error((json && json.error) || ('Le portail a répondu ' + res.status + '.'));
          error.status = res.status;
          error.details = json && json.details;
          throw error;
        }
        return json;
      });
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  function loadHome() {
    return api('GET', 'api/catalog').then(function (catalog) {
      state.catalog = catalog;
      renderHome();
    });
  }

  function canConfigure() {
    var c = state.catalog;
    return c && c.adminEnabled && (c.isOwner || !c.paired);
  }

  function renderHome() {
    var c = state.catalog;
    var head = h('header', { class: 'portail__entete' }, [
      h('div', {}, [
        h('h1', { class: 'fr-h4', text: 'Actions disponibles' }),
        h('p', { class: 'fr-text--sm', text: c.actions.length
          ? 'Choisissez une action, remplissez le formulaire, puis lancez-la.'
          : '' })
      ]),
      canConfigure() ? button('Configurer', function () { renderConfig(); }, 'secondary') : null
    ]);
    var body;
    if (!c.actions.length) {
      body = alertBox('info', !c.paired
        ? "Ce portail n'est pas encore configuré. Son propriétaire peut le faire avec « Configurer »."
        : c.isOwner
          ? "Aucune action n'est ouverte dans ce document. Passez par « Configurer » pour en exposer."
          : "Aucune action n'est ouverte dans ce document. Demandez-en l'accès au propriétaire du portail.");
    } else {
      body = h('ul', { class: 'portail__cartes' }, c.actions.map(function (action) {
        return h('li', { class: 'portail__carte' }, [
          action.icon ? h('span', { class: 'portail__icone', 'aria-hidden': 'true', text: action.icon }) : null,
          h('h2', { class: 'fr-h6', text: action.title }),
          action.description ? h('p', { class: 'fr-text--sm', text: action.description }) : null,
          button('Ouvrir', function () { renderAction(action); }, null, { 'aria-label': 'Ouvrir « ' + action.title + ' »' })
        ]);
      }));
    }
    show(head, body);
  }

  // Le moteur redessine le formulaire à chaque « change », qui part quand le
  // champ perd le focus. Deux pièges en découlent :
  //   à l'appui sur « Envoyer », le champ perd le focus, le formulaire est
  //   redessiné et le bouton remplacé avant le relâchement : le clic se perd ;
  //   si le champ garde le focus, c'est le rendu du clic qui le détruit, et le
  //   change qui s'ensuit relance un rendu au milieu du premier (NotFoundError).
  // D'où : garder le bouton en place à l'appui, puis, au clic et avant le
  // moteur, retirer le focus du champ pour que son change passe d'abord. Le
  // clic atteint quand même son bouton : le trajet de l'événement est fixé.
  function keepFocusOnButtons(container) {
    function onButton(event) {
      return event.target.closest && event.target.closest('button[data-action]');
    }
    container.addEventListener('mousedown', function (event) {
      if (onButton(event)) event.preventDefault();
    }, true);
    container.addEventListener('click', function (event) {
      var active = document.activeElement;
      if (onButton(event) && active && active !== document.body && container.contains(active)) active.blur();
    }, true);
  }

  function renderAction(action) {
    var mountPoint = h('div', { class: 'portail__formulaire' });
    keepFocusOnButtons(mountPoint);
    show(
      h('nav', { class: 'portail__retour' }, [button('← Toutes les actions', renderHome, 'tertiary-no-outline')]),
      mountPoint
    );
    window.FormEngine.mount(mountPoint, action.formdef, {
      skipProbe: true,
      submit: function (data) {
        return api('POST', 'api/run', { action: action.key, inputs: data }).then(function (response) {
          // Le moteur affiche ensuite son message de succès : on le remplace par
          // le résultat, une fois ce rendu passé.
          setTimeout(function () { renderResult(action, response); }, 0);
          return response;
        });
      }
    });
  }

  function isSafeLink(value) {
    return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
  }

  function renderValue(render, value) {
    if (value == null || value === '') return h('p', { class: 'fr-text--sm', text: '(vide)' });
    switch (render) {
      case 'badge': {
        var ok = value === true || value === 'success' || value === 'ok';
        var ko = value === false || value === 'error';
        var label = ok ? 'Réussi' : ko ? 'Échec' : String(value);
        return h('span', { class: 'fr-badge fr-badge--' + (ok ? 'success' : ko ? 'error' : 'info'), text: label });
      }
      case 'link':
        return isSafeLink(value)
          ? h('a', { href: value.trim(), target: '_blank', rel: 'noopener noreferrer', text: value.trim() })
          : h('p', { text: String(value) });
      case 'number':
        return h('p', { class: 'portail__nombre', text: Number.isFinite(Number(value)) ? Number(value).toLocaleString('fr-FR') : String(value) });
      case 'datetime': {
        var d = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
        return h('p', { text: isNaN(d.getTime()) ? String(value) : d.toLocaleString('fr-FR') });
      }
      case 'list':
        return h('ul', { class: 'portail__liste' }, [].concat(value).map(function (item) {
          if (item && typeof item === 'object') {
            var title = item.title || item.titre || item.name || item.nom || '';
            var url = item.url || item.link || item.lien;
            if (title && isSafeLink(url)) {
              return h('li', {}, [h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: title })]);
            }
            return h('li', {}, [h('pre', { class: 'portail__json', text: JSON.stringify(item, null, 2) })]);
          }
          return h('li', { text: String(item) });
        }));
      case 'json':
        return h('pre', { class: 'portail__json', text: JSON.stringify(value, null, 2) });
      default:
        // text, markdown : texte brut, retours à la ligne conservés.
        return typeof value === 'object'
          ? h('pre', { class: 'portail__json', text: JSON.stringify(value, null, 2) })
          : h('p', { class: 'portail__texte', text: String(value) });
    }
  }

  function renderResult(action, response) {
    var result = response.result || {};
    var declared = response.render && response.render.length
      ? response.render
      : Object.keys(result).map(function (key) { return { key: key, label: key, render: typeof result[key] === 'object' ? 'json' : 'text' }; });
    var items = declared.map(function (f) {
      return h('div', { class: 'portail__sortie' }, [
        h('h3', { class: 'portail__sortie-titre', text: f.label || f.key }),
        renderValue(f.render, result[f.key])
      ]);
    });
    show(
      h('nav', { class: 'portail__retour' }, [button('← Toutes les actions', renderHome, 'tertiary-no-outline')]),
      h('h1', { class: 'fr-h4', text: action.title }),
      alertBox('success', response.acknowledgedOnly
        ? 'Demande transmise. Le traitement se poursuit dans n8n.'
        : 'Action terminée en ' + Math.max(1, Math.round(response.durationMs / 1000)) + ' s.'),
      items.length ? h('section', { class: 'portail__resultat', 'aria-label': 'Résultat' }, items) : null,
      h('div', { class: 'fr-btns-group' }, [
        button('Relancer', function () { renderAction(action); }),
        button('Toutes les actions', renderHome, 'secondary')
      ])
    );
  }

  // ── Configurer ───────────────────────────────────────────────────────────

  function renderAdminLogin(message) {
    var input = h('input', { class: 'fr-input', type: 'password', id: 'jeton-admin', autocomplete: 'off' });
    function submit() {
      state.adminToken = input.value.trim();
      writeSession(ADMIN_KEY, state.adminToken);
      renderConfig();
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    show(
      h('nav', { class: 'portail__retour' }, [button('← Actions', renderHome, 'tertiary-no-outline')]),
      h('h1', { class: 'fr-h4', text: 'Configurer le portail' }),
      message ? alertBox('error', message) : null,
      h('div', { class: 'fr-input-group' }, [
        h('label', { class: 'fr-label', for: 'jeton-admin' }, [
          "Jeton d'administration",
          h('span', { class: 'fr-hint-text', text: " — dans les notes du service n8n, sur Onyxia (« Mes services »)." })
        ]),
        input
      ]),
      h('div', { class: 'fr-btns-group' }, [button('Continuer', submit)])
    );
    input.focus();
  }

  function renderConfig() {
    if (!state.adminToken) { renderAdminLogin(); return; }
    show(h('p', { class: 'portail__attente', text: 'Lecture des workflows…' }));
    var start = state.catalog && !state.catalog.paired
      ? api('POST', 'api/admin/pair', undefined, true)
      : Promise.resolve();
    start.then(function () { return api('GET', 'api/admin/state', undefined, true); })
      .then(function (admin) {
        if (state.catalog) { state.catalog.paired = true; state.catalog.isOwner = true; }
        renderAdmin(admin);
      })
      .catch(function (error) {
        if (error.status === 401) {
          state.adminToken = '';
          writeSession(ADMIN_KEY, '');
          renderAdminLogin(error.message);
        } else {
          show(
            h('nav', { class: 'portail__retour' }, [button('← Actions', renderHome, 'tertiary-no-outline')]),
            alertBox('error', error.message)
          );
        }
      });
  }

  function renderAdmin(admin) {
    // alert() et confirm() peuvent être bloqués dans l'iframe du widget : les
    // messages s'affichent dans la page.
    var notice = h('div', { role: 'status' });
    function report(error) { notice.replaceChildren(alertBox('error', error.message)); }
    var opened = {};
    admin.openedHere.forEach(function (key) { opened[key] = true; });
    var keys = Object.keys(admin.actions).sort();

    var actionsList = keys.length
      ? h('ul', { class: 'portail__admin-liste' }, keys.map(function (key) {
          var action = admin.actions[key];
          var box = h('input', { type: 'checkbox', id: 'ouvrir-' + key, checked: !!opened[key] });
          box.addEventListener('change', function () { opened[key] = box.checked; });
          return h('li', { class: 'portail__admin-ligne' }, [
            h('div', { class: 'fr-checkbox-group' }, [
              box,
              h('label', { class: 'fr-label', for: 'ouvrir-' + key }, [
                (action.icon ? action.icon + ' ' : '') + action.formdef.title,
                h('span', { class: 'fr-hint-text', text: ' — ' + key + ' · workflow « ' + action.workflowName + ' »' })
              ])
            ]),
            h('div', { class: 'portail__admin-boutons' }, [
              button('Modifier', function () { renderEditor({ key: key, workflowId: action.workflowId, node: action.node, icon: action.icon, formdef: action.formdef, existing: true }); }, 'sm'),
              button('Retirer', function (event) {
                var btn = event.currentTarget;
                if (btn.getAttribute('data-confirm') !== 'oui') {
                  btn.setAttribute('data-confirm', 'oui');
                  btn.textContent = 'Retirer de tous les documents ?';
                  return;
                }
                api('DELETE', 'api/admin/action', { key: key }, true).then(renderConfig, report);
              }, 'sm fr-btn--secondary')
            ])
          ]);
        }))
      : h('p', { class: 'fr-text--sm', text: "Aucune action exposée pour l'instant : choisissez un workflow ci-dessous." });

    var saveStatus = h('p', { class: 'fr-text--sm', role: 'status' });
    var saveAccess = button('Enregistrer les accès de ce document', function () {
      var chosen = keys.filter(function (k) { return opened[k]; });
      api('POST', 'api/admin/access', { actions: chosen }, true).then(function (r) {
        saveStatus.textContent = r.openedHere.length
          ? r.openedHere.length + ' action(s) ouverte(s) à toute personne ayant accès à ce document.'
          : 'Aucune action ouverte dans ce document.';
        return api('GET', 'api/catalog').then(function (c) { state.catalog = c; });
      }, function (e) { saveStatus.textContent = e.message; });
    });

    var workflows = h('ul', { class: 'portail__admin-liste' }, admin.workflows.map(function (wf) {
      var triggers = wf.triggers.length ? wf.triggers.map(function (t) {
        return h('li', { class: 'portail__declencheur' }, [
          h('span', { class: 'portail__mono', text: t.node + ' · ' + t.method + ' /' + (t.path || '?') }),
          t.blocker
            ? h('span', { class: 'fr-badge fr-badge--warning', text: 'Non exposable : ' + t.blocker })
            : button('Exposer', function () {
                api('POST', 'api/admin/draft', { workflowId: wf.id, node: t.node }, true).then(function (draft) {
                  renderEditor({ key: draft.key, workflowId: wf.id, node: t.node, icon: '', formdef: draft.formdef, existing: false });
                }, report);
              }, 'sm')
        ]);
      }) : [h('li', { class: 'fr-text--sm', text: 'Pas de déclencheur webhook : ce workflow ne peut pas devenir une action.' })];
      return h('li', { class: 'portail__admin-ligne portail__admin-ligne--colonne' }, [
        h('div', { class: 'portail__admin-titre' }, [
          h('strong', { text: wf.name }),
          h('span', { class: 'fr-badge ' + (wf.published ? 'fr-badge--success' : 'fr-badge--warning'), text: wf.published ? 'Publié' : 'Non publié' }),
          wf.exposedAs.length ? h('span', { class: 'fr-badge fr-badge--info', text: 'Exposé : ' + wf.exposedAs.join(', ') }) : null
        ]),
        h('ul', { class: 'portail__declencheurs' }, triggers)
      ]);
    }));

    show(
      h('nav', { class: 'portail__retour' }, [button('← Actions', function () { loadHome().catch(renderFatal); }, 'tertiary-no-outline')]),
      h('h1', { class: 'fr-h4', text: 'Configurer le portail' }),
      notice,
      h('section', { class: 'portail__bloc' }, [
        h('h2', { class: 'fr-h5', text: 'Actions exposées' }),
        h('p', { class: 'fr-text--sm', text: 'Cochez celles à ouvrir dans ce document : toute personne qui y a accès pourra les lancer.' }),
        actionsList,
        keys.length ? h('div', { class: 'fr-btns-group' }, [saveAccess]) : null,
        saveStatus
      ]),
      h('section', { class: 'portail__bloc' }, [
        h('h2', { class: 'fr-h5', text: 'Workflows de votre n8n' }),
        h('p', { class: 'fr-text--sm', text: 'Un workflow devient une action par son déclencheur webhook (méthode POST). Il doit être publié pour répondre.' }),
        workflows
      ])
    );
  }

  function renderEditor(draft) {
    var keyInput = h('input', { class: 'fr-input', id: 'cle-action', value: draft.key, disabled: draft.existing });
    var iconInput = h('input', { class: 'fr-input', id: 'icone-action', value: draft.icon || '', maxlength: '8' });
    var json = h('textarea', { class: 'fr-input portail__json-edit', id: 'formdef-action', rows: '18', spellcheck: 'false' });
    json.value = JSON.stringify(draft.formdef, null, 2);
    var feedback = h('div', { role: 'status' });
    var preview = h('div', { class: 'portail__apercu' });
    keepFocusOnButtons(preview);
    var pending = null;
    // L'aperçu suit la saisie, une fois le JSON lisible.
    json.addEventListener('input', function () {
      clearTimeout(pending);
      pending = setTimeout(function () {
        try { JSON.parse(json.value); } catch (e) { return; }
        showPreview();
      }, 400);
    });

    function parse() {
      try {
        var fd = JSON.parse(json.value);
        var key = keyInput.value.trim();
        if (fd && typeof fd === 'object') {
          fd.id = key;
          fd.target = Object.assign({}, fd.target, { kind: 'action', action: key });
        }
        return fd;
      } catch (e) {
        feedback.replaceChildren(alertBox('error', 'JSON illisible : ' + e.message));
        return null;
      }
    }

    function showPreview() {
      var fd = parse();
      if (!fd) return;
      feedback.replaceChildren();
      preview.replaceChildren();
      try {
        window.FormEngine.mount(preview, fd, {
          skipProbe: true,
          submit: function () { return Promise.reject(new Error('Aperçu : rien n\'est envoyé.')); }
        });
      } catch (e) {
        feedback.replaceChildren(alertBox('error', 'Aperçu impossible : ' + e.message));
      }
    }

    function save() {
      var fd = parse();
      if (!fd) return;
      api('POST', 'api/admin/action', {
        key: keyInput.value.trim(), workflowId: draft.workflowId, node: draft.node, icon: iconInput.value.trim(), formdef: fd
      }, true).then(function (r) {
        feedback.replaceChildren(alertBox(r.published ? 'success' : 'warning', r.published
          ? 'Action enregistrée. Ouvrez-la dans ce document depuis la liste.'
          : 'Action enregistrée, mais le workflow n\'est pas publié dans n8n : elle échouera tant qu\'il ne l\'est pas.'));
        setTimeout(renderConfig, 1200);
      }, function (e) {
        feedback.replaceChildren(alertBox('error', e.message, e.details));
      });
    }

    show(
      h('nav', { class: 'portail__retour' }, [button('← Configuration', renderConfig, 'tertiary-no-outline')]),
      h('h1', { class: 'fr-h4', text: draft.existing ? 'Modifier l\'action' : 'Exposer un workflow' }),
      h('div', { class: 'portail__editeur' }, [
        h('div', {}, [
          h('div', { class: 'portail__ligne-champs' }, [
            h('div', { class: 'fr-input-group' }, [h('label', { class: 'fr-label', for: 'cle-action', text: 'Identifiant' }), keyInput]),
            h('div', { class: 'fr-input-group' }, [h('label', { class: 'fr-label', for: 'icone-action', text: 'Icône' }), iconInput])
          ]),
          h('div', { class: 'fr-input-group' }, [
            h('label', { class: 'fr-label', for: 'formdef-action' }, [
              'Formulaire (FormDef)',
              h('span', { class: 'fr-hint-text', text: ' — titre, sections et champs ; « result » décrit ce qui est affiché du retour.' })
            ]),
            json
          ]),
          feedback,
          h('div', { class: 'fr-btns-group' }, [
            button('Enregistrer', save),
            button('Aperçu', showPreview, 'secondary'),
            button('Annuler', renderConfig, 'tertiary-no-outline')
          ])
        ]),
        h('section', { class: 'portail__apercu-cadre', 'aria-label': 'Aperçu du formulaire' }, [
          h('h2', { class: 'fr-h6', text: 'Aperçu' }),
          preview
        ])
      ])
    );
    showPreview();
  }

  // ── Démarrage ────────────────────────────────────────────────────────────

  function renderFatal(error) {
    show(alertBox('error', (error && error.message) || 'Le portail est indisponible.'));
  }

  if (!window.grist || !window.grist.docApi) {
    show(alertBox('info', 'Ce portail s\'utilise comme widget personnalisé dans un document Grist, avec un accès complet au document.'));
    return;
  }
  window.grist.ready({ requiredAccess: 'full' });
  loadHome().catch(function (error) {
    if (/access|accès|permission/i.test(error && error.message || '')) {
      renderFatal(new Error('Le widget doit avoir un accès complet au document (réglage « Accès » du widget).'));
    } else {
      renderFatal(error);
    }
  });
})();
