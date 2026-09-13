// Interface du portail, chargée comme widget personnalisé dans Grist.
//
// Deux usages :
//   Actions    : le lecteur voit les actions ouvertes dans ce document, remplit
//                le formulaire (moteur grist_forms) et lit le résultat ;
//   Configurer : le propriétaire choisit les workflows exposés et règle leur
//                formulaire dans un éditeur visuel, avec aperçu et essai réel.
//
// Aucune valeur venue d'un workflow, d'un formulaire ou du document n'est
// injectée en HTML : tout passe par textContent ou des nœuds construits. Le
// moteur échappe lui-même ce qu'il rend.

(function () {
  'use strict';

  var SESSION_KEY = 'portail-session';
  var root = document.getElementById('app');
  var state = {
    token: null,
    tokenExp: 0,
    baseUrl: null,
    catalog: null,
    admin: null,
    docName: '',
    mode: 'actions',
    session: readSession(SESSION_KEY)
  };

  function readSession(key) {
    try { return window.sessionStorage.getItem(key) || ''; } catch (e) { return ''; }
  }

  function writeSession(key, value) {
    try {
      if (value) window.sessionStorage.setItem(key, value);
      else window.sessionStorage.removeItem(key);
    } catch (e) { /* stockage indisponible : la session reste en mémoire */ }
  }

  // ── Construction du DOM ──────────────────────────────────────────────────

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (name) {
      var value = attrs[name];
      if (value == null || value === false) return;
      if (name === 'text') el.textContent = value;
      else if (name === 'class') el.className = value;
      else if (name === 'value') el.value = value;
      else if (name.indexOf('on') === 0) el.addEventListener(name.slice(2), value);
      else el.setAttribute(name, value === true ? '' : value);
    });
    append(el, children);
    return el;
  }

  // Remplace le contenu d'un nœud. replaceChildren n'aplatit pas les listes :
  // un tableau y deviendrait le texte « [object HTMLDivElement] ».
  function fill(el) {
    el.replaceChildren();
    return append(el, [].slice.call(arguments, 1));
  }

  function append(el, children) {
    [].concat(children == null ? [] : children).forEach(function (child) {
      if (child == null || child === false) return;
      if (Array.isArray(child)) { append(el, child); return; }
      el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return el;
  }

  // Icônes dessinées : quelques traits, dans la couleur du texte.
  var ICONS = {
    bolt: [['path', { d: 'M13 2 4 14h7l-1 8 9-12h-7l1-8z' }]],
    sliders: [['path', { d: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1' }], ['circle', { cx: 15, cy: 6, r: 2 }], ['circle', { cx: 9, cy: 12, r: 2 }], ['circle', { cx: 17, cy: 18, r: 2 }]],
    back: [['path', { d: 'M15 18l-6-6 6-6' }]],
    arrow: [['path', { d: 'M5 12h14M13 6l6 6-6 6' }]],
    check: [['path', { d: 'M5 12l5 5 9-10' }]],
    alert: [['path', { d: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01' }]],
    info: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 11v5M12 8h.01' }]],
    lock: [['rect', { x: 5, y: 11, width: 14, height: 10, rx: 2 }], ['path', { d: 'M8 11V7a4 4 0 0 1 8 0v4' }]],
    doc: [['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5' }]],
    table: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['path', { d: 'M3 10h18M9 10v10' }]],
    server: [['rect', { x: 3, y: 4, width: 18, height: 7, rx: 2 }], ['rect', { x: 3, y: 13, width: 18, height: 7, rx: 2 }], ['path', { d: 'M7 7.5h.01M7 16.5h.01' }]],
    user: [['circle', { cx: 12, cy: 8, r: 4 }], ['path', { d: 'M4 21a8 8 0 0 1 16 0' }]],
    pencil: [['path', { d: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4' }]],
    trash: [['path', { d: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13' }]],
    plus: [['path', { d: 'M12 5v14M5 12h14' }]],
    up: [['path', { d: 'M6 15l6-6 6 6' }]],
    down: [['path', { d: 'M6 9l6 6 6-6' }]],
    play: [['path', { d: 'M8 5v14l11-7z' }]],
    copy: [['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ['path', { d: 'M5 15V6a2 2 0 0 1 2-2h8' }]],
    search: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'M20 20l-4-4' }]],
    code: [['path', { d: 'M8 8l-4 4 4 4M16 8l4 4-4 4' }]],
    flow: [['rect', { x: 3, y: 4, width: 7, height: 5, rx: 1.5 }], ['rect', { x: 14, y: 15, width: 7, height: 5, rx: 1.5 }], ['path', { d: 'M10 6.5h2.5a2 2 0 0 1 2 2V15' }]],
    logout: [['path', { d: 'M15 12H4M8 8l-4 4 4 4M13 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5' }]],
    eye: [['path', { d: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
    text: [['path', { d: 'M4 7V5h16v2M12 5v14M9 19h6' }]],
    lines: [['path', { d: 'M4 6h16M4 11h16M4 16h10' }]],
    hash: [['path', { d: 'M5 9h14M5 15h14M10 4 8 20M16 4l-2 16' }]],
    calendar: [['rect', { x: 3, y: 5, width: 18, height: 16, rx: 2 }], ['path', { d: 'M3 10h18M8 3v4M16 3v4' }]],
    list: [['path', { d: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01' }]],
    radio: [['circle', { cx: 12, cy: 12, r: 8 }], ['circle', { cx: 12, cy: 12, r: 3 }]],
    checks: [['rect', { x: 3, y: 3, width: 8, height: 8, rx: 2 }], ['rect', { x: 13, y: 13, width: 8, height: 8, rx: 2 }], ['path', { d: 'M5 7l1.5 1.5L9 5.5M15 17l1.5 1.5 2.5-3' }]],
    toggle: [['rect', { x: 2, y: 7, width: 20, height: 10, rx: 5 }], ['circle', { cx: 16, cy: 12, r: 3 }]],
    scale: [['path', { d: 'M4 18h2v-3H4zM9 18h2v-6H9zM14 18h2V9h-2zM19 18h2V5h-2z' }]]
  };

  function icon(name, cls) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    (ICONS[name] || ICONS.bolt).forEach(function (part) {
      var node = document.createElementNS(ns, part[0]);
      Object.keys(part[1]).forEach(function (k) { node.setAttribute(k, part[1][k]); });
      svg.appendChild(node);
    });
    return svg;
  }

  function button(label, onclick, variant, attrs) {
    var cls = 'btn' + (variant ? ' ' + variant.split(' ').map(function (v) { return 'btn--' + v; }).join(' ') : '');
    var content = Array.isArray(label) ? label : [label];
    return h('button', Object.assign({ type: 'button', class: cls, onclick: onclick }, attrs || {}), content);
  }

  function notice(kind, message, details) {
    var ic = { ok: 'check', warn: 'alert', err: 'alert', info: 'info' }[kind] || 'info';
    return h('div', { class: 'notice notice--' + kind, role: kind === 'err' ? 'alert' : 'status' }, [
      icon(ic),
      h('div', {}, [
        h('p', { text: message }),
        details && details.length ? h('ul', {}, details.map(function (d) { return h('li', { text: d }); })) : null
      ])
    ]);
  }

  function chip(text, kind, iconName) {
    return h('span', { class: 'chip' + (kind ? ' chip--' + kind : '') }, [iconName ? icon(iconName, 'icon--sm') : null, text]);
  }

  function switchInput(id, checked, label, hint, onchange) {
    var input = h('input', { type: 'checkbox', id: id, checked: !!checked, role: 'switch' });
    input.addEventListener('change', function () { onchange(input.checked); });
    return h('label', { class: 'switch', for: id }, [
      input,
      h('span', { class: 'switch__track', 'aria-hidden': 'true' }),
      h('span', { class: 'switch__text' }, [h('span', { text: label }), hint ? h('small', { text: hint }) : null])
    ]);
  }

  function segmented(options, value, onchange) {
    var group = h('div', { class: 'segmented', role: 'group' });
    options.forEach(function (opt) {
      group.appendChild(h('button', {
        type: 'button', 'aria-pressed': String(opt.value === value), text: opt.label,
        onclick: function () {
          Array.prototype.forEach.call(group.children, function (b) { b.setAttribute('aria-pressed', 'false'); });
          this.setAttribute('aria-pressed', 'true');
          onchange(opt.value);
        }
      }));
    });
    return group;
  }

  function field(label, control, hint, id) {
    return h('div', { class: 'field' }, [
      h('label', { for: id || control.id || null, text: label }),
      control,
      hint ? h('span', { class: 'field__hint', text: hint }) : null
    ]);
  }

  function pageHead(title, subtitle, side, lead) {
    return h('div', { class: 'page-head' }, [
      h('div', { class: subtitle ? 'row row--top' : 'row' }, [
        lead || null,
        h('div', {}, [h('h1', { text: title }), subtitle ? h('p', { text: subtitle }) : null])
      ]),
      side || null
    ]);
  }

  function backLink(label, onclick) {
    return h('div', {}, [h('button', { type: 'button', class: 'back', onclick: onclick }, [icon('back', 'icon--sm'), label])]);
  }

  function actionIcon(action) {
    return action && action.icon ? document.createTextNode(action.icon) : icon('bolt', 'icon--lg');
  }

  var uidCounter = 0;
  function uid() { uidCounter += 1; return 'u' + uidCounter; }

  function debounce(fn, ms) {
    var t = null;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  // ── Coquille ─────────────────────────────────────────────────────────────

  function canConfigure() {
    var c = state.catalog;
    return c && c.anonymous === false && (c.isOwner || !c.paired);
  }

  function shell(children, opts) {
    opts = opts || {};
    var nav = null;
    if (canConfigure()) {
      nav = h('nav', { class: 'modes', 'aria-label': 'Mode' }, [
        h('button', { type: 'button', 'aria-pressed': String(state.mode === 'actions'), onclick: function () { loadHome().catch(renderFatal); } }, [icon('bolt', 'icon--sm'), 'Actions']),
        h('button', { type: 'button', 'aria-pressed': String(state.mode === 'config'), onclick: function () { renderConfig(); } }, [icon('sliders', 'icon--sm'), 'Configurer'])
      ]);
    }
    var top = h('header', { class: 'topbar' }, [
      h('div', { class: 'brand' }, [
        h('span', { class: 'brand__mark' }, [icon('bolt')]),
        h('div', {}, [
          h('div', { class: 'brand__title', text: 'Portail d\'actions' }),
          h('div', { class: 'brand__sub', text: state.docName || 'Document Grist' })
        ])
      ]),
      nav
    ]);
    var main = h('main', { class: 'view' + (opts.wide ? ' view--wide' : '') }, children);
    root.replaceChildren(top, main);
    window.scrollTo(0, 0);
    return main;
  }

  function renderFatal(error) {
    shell([notice('err', (error && error.message) || 'Le portail est indisponible.')]);
  }

  // ── Accès au portail ─────────────────────────────────────────────────────

  function gristAuth() {
    if (state.token && Date.now() < state.tokenExp) return Promise.resolve();
    // Lecture seule : ce jeton ne sert qu'à prouver qui regarde, et depuis quel
    // document.
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
      if (admin) headers.authorization = 'Bearer ' + state.session;
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

  function accessChips(action) {
    return [
      action.gristAccess === 'read' ? chip('Lit ce document', 'grist', 'eye') : null,
      action.gristAccess === 'write' ? chip('Modifie ce document', 'warn', 'pencil') : null,
      action.writeBack ? chip('Enregistre le résultat', 'grist', 'table') : null
    ];
  }

  function renderHome() {
    state.mode = 'actions';
    var c = state.catalog;
    var actions = c.actions || [];
    var head = pageHead('Actions disponibles', actions.length
      ? 'Choisissez une action : un formulaire guidé vous accompagne, puis le résultat s\'affiche ici.'
      : '');
    if (!actions.length) {
      var message = c.signInRequired
        ? ['Connectez-vous à Grist', 'Les actions de ce document sont réservées aux personnes connectées.']
        : !c.paired
          ? ['Portail à configurer', 'Son propriétaire peut le faire avec « Configurer », une fois connecté à Grist.']
          : c.isOwner
            ? ['Aucune action ouverte ici', 'Passez par « Configurer » pour mettre des workflows à disposition dans ce document.']
            : ['Aucune action ouverte ici', 'Demandez-en l\'accès au propriétaire du portail.'];
      shell([head, h('div', { class: 'empty' }, [icon(c.signInRequired ? 'lock' : 'bolt'), h('strong', { text: message[0] }), h('span', { text: message[1] })])]);
      return;
    }
    var list = h('ul', { class: 'actions-grid' });
    function paint(query) {
      var q = (query || '').trim().toLowerCase();
      var shown = actions.filter(function (a) { return !q || (a.title + ' ' + a.description).toLowerCase().indexOf(q) !== -1; });
      list.replaceChildren.apply(list, shown.map(function (action) {
        return h('li', {}, [h('button', { type: 'button', class: 'action-card', onclick: function () { renderAction(action); } }, [
          h('span', { class: 'action-card__icon', 'aria-hidden': 'true' }, [actionIcon(action)]),
          h('span', { class: 'action-card__title', text: action.title }),
          h('span', { class: 'action-card__desc', text: action.description || '' }),
          h('span', { class: 'action-card__foot' }, [
            h('span', { class: 'row' }, accessChips(action)),
            h('span', { class: 'action-card__go' }, ['Ouvrir', icon('arrow', 'icon--sm')])
          ])
        ])]);
      }));
      if (!shown.length) list.appendChild(h('li', { class: 'empty' }, [h('span', { text: 'Aucune action ne correspond à « ' + query + ' ».' })]));
    }
    var toolbar = null;
    if (actions.length > 6) {
      var input = h('input', { class: 'input', type: 'search', id: 'recherche', placeholder: 'Rechercher une action', 'aria-label': 'Rechercher une action' });
      input.addEventListener('input', function () { paint(input.value); });
      toolbar = h('div', { class: 'toolbar' }, [h('div', { class: 'search' }, [icon('search', 'icon--sm'), input])]);
    }
    paint('');
    shell([head, toolbar, list]);
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

  // Suivi d'une exécution : barre animée et secondes écoulées.
  function progress(host) {
    var started = Date.now();
    var text = h('span', { class: 'progress__text', text: 'Exécution en cours…' });
    host.replaceChildren(h('div', { class: 'progress' }, [h('div', { class: 'progress__bar' }), text]));
    var timer = setInterval(function () {
      text.textContent = 'Exécution en cours… ' + Math.round((Date.now() - started) / 1000) + ' s';
    }, 1000);
    return function stop() { clearInterval(timer); host.replaceChildren(); };
  }

  // Jeton propre à ce lancement, demandé au dernier moment : il n'est valable
  // que quelques minutes et pour ce seul document.
  function delegatedToken(action) {
    if (!action.gristAccess || action.gristAccess === 'none') return Promise.resolve(null);
    return window.grist.docApi.getAccessToken({ readOnly: action.gristAccess !== 'write' }).then(function (tk) {
      return { token: tk.token };
    });
  }

  function consentCard(action) {
    var items = [
      ['server', 'Exécutée par le service n8n du propriétaire de ce portail : vos réponses lui sont transmises.'],
      ['user', 'Votre identité Grist est vérifiée et communiquée au workflow.']
    ];
    if (action.gristAccess === 'read') items.push(['eye', 'Le workflow pourra lire ce document, avec vos droits.']);
    if (action.gristAccess === 'write') items.push(['pencil', 'Le workflow pourra lire et modifier ce document, avec vos droits, pendant quelques minutes.']);
    if (action.writeBack) items.push(['table', 'Le résultat sera enregistré dans la table « ' + action.writeBack.tableId + ' ».']);
    return h('aside', { class: 'card' }, [
      h('h2', { class: 'card__title' }, [icon('info'), 'Avant de lancer']),
      h('div', { class: 'consent' }, items.map(function (it) { return h('div', { class: 'consent__item' }, [icon(it[0], 'icon--sm'), h('span', { text: it[1] })]); }))
    ]);
  }

  function renderAction(action) {
    var formHost = h('div');
    var status = h('div');
    keepFocusOnButtons(formHost);
    shell([
      backLink('Toutes les actions', renderHome),
      pageHead(action.title, action.description, null, h('span', { class: 'icon-tile', 'aria-hidden': 'true' }, [actionIcon(action)])),
      h('div', { class: 'run-layout' }, [h('section', { class: 'card' }, [formHost, status]), consentCard(action)])
    ]);
    // Le titre et la description sont déjà dans l'en-tête de la page.
    var formdef = Object.assign({}, action.formdef, { title: '', description: '' });
    window.FormEngine.mount(formHost, formdef, {
      skipProbe: true,
      submit: function (data) {
        var stop = progress(status);
        return delegatedToken(action).then(function (delegated) {
          var body = { action: action.key, inputs: data };
          if (delegated) body.delegated = delegated;
          return api('POST', 'api/run', body);
        }).then(function (response) {
          stop();
          // Le moteur affiche ensuite son message de succès : on le remplace par
          // le résultat, une fois ce rendu passé.
          setTimeout(function () { renderResult(action, response); }, 0);
          return response;
        }, function (error) {
          stop();
          throw error;
        });
      }
    });
  }

  // ── Résultat ─────────────────────────────────────────────────────────────

  function isSafeLink(value) {
    return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
  }

  // Markdown réduit, construit en nœuds : titres, listes, gras, italique,
  // code, liens http(s). Rien n'est interprété comme HTML.
  function inlineMarkdown(text) {
    var nodes = [];
    var re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*([^*]+)\*)/g;
    var last = 0;
    var m;
    while ((m = re.exec(text))) {
      if (m.index > last) nodes.push(document.createTextNode(text.slice(last, m.index)));
      if (m[2]) nodes.push(h('strong', { text: m[2] }));
      else if (m[3]) nodes.push(h('code', { text: m[3] }));
      else if (m[4]) nodes.push(h('a', { href: m[5], target: '_blank', rel: 'noopener noreferrer', text: m[4] }));
      else if (m[6]) nodes.push(h('em', { text: m[6] }));
      last = re.lastIndex;
    }
    if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
    return nodes;
  }

  function renderMarkdown(text) {
    var out = h('div', { class: 'md' });
    var lines = String(text).split(/\r?\n/);
    var bullet = /^\s*[-*]\s+/;
    var numbered = /^\s*\d+[.)]\s+/;
    var heading = /^(#{1,3})\s+(.*)$/;
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i += 1; continue; }
      var hm = heading.exec(line);
      if (hm) { out.appendChild(h(hm[1].length === 1 ? 'h4' : 'h5', {}, inlineMarkdown(hm[2]))); i += 1; continue; }
      if (bullet.test(line) || numbered.test(line)) {
        var ordered = numbered.test(line);
        var re = ordered ? numbered : bullet;
        var listEl = h(ordered ? 'ol' : 'ul');
        while (i < lines.length && re.test(lines[i])) {
          listEl.appendChild(h('li', {}, inlineMarkdown(lines[i].replace(re, ''))));
          i += 1;
        }
        out.appendChild(listEl);
        continue;
      }
      var para = [];
      while (i < lines.length && lines[i].trim() && !heading.test(lines[i]) && !bullet.test(lines[i]) && !numbered.test(lines[i])) {
        para.push(lines[i]);
        i += 1;
      }
      out.appendChild(h('p', {}, inlineMarkdown(para.join(' '))));
    }
    return out;
  }

  function renderValue(render, value) {
    if (value == null || value === '') return h('span', { class: 'field__hint', text: '(vide)' });
    switch (render) {
      case 'badge': {
        var ok = value === true || value === 'success' || value === 'ok';
        var ko = value === false || value === 'error';
        return h('div', {}, [chip(ok ? 'Réussi' : ko ? 'Échec' : String(value), ok ? 'ok' : ko ? 'err' : 'info', ok ? 'check' : ko ? 'alert' : null)]);
      }
      case 'link':
        return isSafeLink(value)
          ? h('a', { href: value.trim(), target: '_blank', rel: 'noopener noreferrer', text: value.trim() })
          : h('p', { class: 'result__text', text: String(value) });
      case 'number':
        return h('div', { class: 'result__number', text: Number.isFinite(Number(value)) ? Number(value).toLocaleString('fr-FR') : String(value) });
      case 'datetime': {
        var d = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
        return h('p', { class: 'result__text', text: isNaN(d.getTime()) ? String(value) : d.toLocaleString('fr-FR') });
      }
      case 'list':
        return h('ul', { class: 'result__list' }, [].concat(value).map(function (item) {
          if (item && typeof item === 'object') {
            var title = item.title || item.titre || item.name || item.nom || '';
            var url = item.url || item.link || item.lien;
            if (title && isSafeLink(url)) return h('li', {}, [h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: title })]);
            return h('li', {}, [h('pre', { class: 'result__json', text: JSON.stringify(item, null, 2) })]);
          }
          return h('li', { text: String(item) });
        }));
      case 'json':
        return h('pre', { class: 'result__json', text: JSON.stringify(value, null, 2) });
      case 'markdown':
        return typeof value === 'object' ? h('pre', { class: 'result__json', text: JSON.stringify(value, null, 2) }) : renderMarkdown(value);
      default:
        return typeof value === 'object'
          ? h('pre', { class: 'result__json', text: JSON.stringify(value, null, 2) })
          : h('p', { class: 'result__text', text: String(value) });
    }
  }

  function copyButton(value) {
    var label = h('span', { text: 'Copier' });
    return button([icon('copy', 'icon--sm'), label], function () {
      var text = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
      var done = function (message) {
        label.textContent = message;
        setTimeout(function () { label.textContent = 'Copier'; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done('Copié'); }, function () { done('Copie refusée'); });
      } else {
        done('Copie indisponible');
      }
    }, 'quiet sm');
  }

  function resultBlocks(result, declared) {
    var fields = declared && declared.length
      ? declared
      : Object.keys(result).map(function (key) { return { key: key, label: key, render: typeof result[key] === 'object' ? 'json' : 'text' }; });
    return h('div', { class: 'result' }, fields.map(function (f) {
      var value = result[f.key];
      var copyable = value != null && value !== '' && ['text', 'markdown', 'json', 'link', undefined].indexOf(f.render) !== -1;
      return h('div', { class: 'result__item' }, [
        h('div', { class: 'result__label' }, [h('span', { text: f.label || f.key }), copyable ? copyButton(value) : null]),
        renderValue(f.render, value)
      ]);
    }));
  }

  // Écriture du résultat par le widget lui-même, avec les droits du lecteur :
  // le portail n'a aucun accès en écriture au document.
  function writeBack(action, result) {
    if (!action.writeBack) return Promise.resolve(null);
    var fields = {};
    Object.keys(action.writeBack.fields).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(result, key)) return;
      var v = result[key];
      fields[action.writeBack.fields[key]] = v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    });
    if (!Object.keys(fields).length) return Promise.reject(new Error('le résultat ne contient aucune des clés à enregistrer'));
    return window.grist.docApi.applyUserActions([['AddRecord', action.writeBack.tableId, null, fields]]);
  }

  function renderResult(action, response) {
    var result = response.result || {};
    var saved = h('div');
    if (action.writeBack) {
      saved.replaceChildren(notice('info', 'Enregistrement du résultat dans « ' + action.writeBack.tableId + ' »…'));
      writeBack(action, result).then(function () {
        saved.replaceChildren(notice('ok', 'Résultat enregistré dans la table « ' + action.writeBack.tableId + ' ».'));
      }, function (error) {
        saved.replaceChildren(notice('warn', 'Résultat affiché mais non enregistré dans « ' + action.writeBack.tableId + ' » : ' + ((error && error.message) || 'écriture refusée') + '.'));
      });
    }
    var seconds = Math.max(1, Math.round(response.durationMs / 1000));
    shell([
      backLink('Toutes les actions', renderHome),
      pageHead(action.title, null, null, h('span', { class: 'icon-tile', 'aria-hidden': 'true' }, [actionIcon(action)])),
      notice('ok', response.acknowledgedOnly ? 'Demande transmise : le traitement se poursuit dans n8n.' : 'Action terminée en ' + seconds + ' s.'),
      Object.keys(result).length ? h('section', { class: 'card', 'aria-label': 'Résultat' }, [resultBlocks(result, response.render)]) : null,
      saved,
      h('div', { class: 'row' }, [
        button([icon('play', 'icon--sm'), 'Relancer'], function () { renderAction(action); }),
        button('Toutes les actions', renderHome, 'ghost')
      ])
    ]);
  }

  // ── Se connecter à n8n ───────────────────────────────────────────────────

  var LOGIN = {
    mcp: { label: 'Jeton MCP', hint: 'Dans les notes du service n8n sur Onyxia : celui que vous avez donné à votre assistant.' },
    compte: { label: 'Compte n8n', hint: 'L\'email et le mot de passe du service n8n (bouton « Copier le mot de passe » sur Onyxia).' },
    cle: { label: 'Clé API', hint: 'Dans n8n : Settings → n8n API → Create an API key.' }
  };

  function loginMethods() {
    return (state.catalog && state.catalog.loginMethods) || ['compte', 'cle'];
  }

  function renderAdminLogin(message, mode) {
    state.mode = 'config';
    mode = mode || loginMethods()[0];
    var pending = false;
    var fields = mode === 'compte'
      ? {
          email: h('input', { class: 'input', type: 'email', id: 'n8n-email', autocomplete: 'username' }),
          password: h('input', { class: 'input', type: 'password', id: 'n8n-mdp', autocomplete: 'current-password' }),
          mfaCode: h('input', { class: 'input', type: 'text', id: 'n8n-mfa', inputmode: 'numeric', autocomplete: 'one-time-code' })
        }
      : mode === 'mcp'
        ? { mcpToken: h('input', { class: 'input input--mono', type: 'password', id: 'jeton-mcp', autocomplete: 'off' }) }
        : { apiKey: h('input', { class: 'input input--mono', type: 'password', id: 'cle-n8n', autocomplete: 'off' }) };
    var submitBtn = button('Se connecter', submit);

    function submit() {
      var body = {};
      Object.keys(fields).forEach(function (k) { if (fields[k].value.trim()) body[k] = fields[k].value.trim(); });
      var complete = mode === 'compte' ? body.email && body.password : mode === 'mcp' ? body.mcpToken : body.apiKey;
      if (pending || !complete) return;
      pending = true;
      submitBtn.disabled = true;
      api('POST', 'api/admin/login', body).then(function (r) {
        Object.keys(fields).forEach(function (k) { fields[k].value = ''; });
        state.session = r.session;
        writeSession(SESSION_KEY, r.session);
        if (state.catalog) { state.catalog.paired = true; state.catalog.isOwner = true; }
        renderConfig();
      }, function (error) {
        renderAdminLogin(error.message, mode);
      });
    }
    Object.keys(fields).forEach(function (k) {
      fields[k].addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    });

    var body = mode === 'compte'
      ? [field('Email du compte n8n', fields.email), field('Mot de passe n8n', fields.password),
         field('Code de double authentification', fields.mfaCode, 'Seulement si elle est activée sur ce compte.')]
      : [field(mode === 'mcp' ? 'Jeton du serveur MCP' : 'Clé API de votre n8n', fields.mcpToken || fields.apiKey)];

    shell([h('section', { class: 'card login' }, [
      h('div', {}, [
        h('h1', { class: 'card__title' }, [icon('lock'), 'Se connecter à n8n']),
        h('p', { class: 'card__sub', text: 'Pour configurer le portail, prouvez que vous tenez ce n8n. Seule une session d\'une heure est gardée.' })
      ]),
      message ? notice('err', message) : null,
      loginMethods().length > 1 ? segmented(loginMethods().map(function (m) { return { value: m, label: LOGIN[m].label }; }), mode, function (m) { renderAdminLogin('', m); }) : null,
      h('p', { class: 'field__hint', text: LOGIN[mode].hint }),
      body,
      state.catalog && !state.catalog.paired ? notice('info', 'Première connexion : votre compte Grist deviendra le propriétaire de ce portail.') : null,
      h('div', { class: 'row row--end' }, [submitBtn])
    ])]);
    (fields.mcpToken || fields.email || fields.apiKey).focus();
  }

  // ── Configurer ───────────────────────────────────────────────────────────

  function renderConfig(tab) {
    state.mode = 'config';
    if (!state.session) { renderAdminLogin(); return; }
    shell([h('p', { class: 'field__hint', text: 'Lecture des workflows…' })]);
    api('GET', 'api/admin/state', undefined, true)
      .then(function (admin) { state.admin = admin; renderAdmin(admin, tab); })
      .catch(function (error) {
        if (error.status === 401) {
          state.session = '';
          writeSession(SESSION_KEY, '');
          renderAdminLogin(error.message);
        } else {
          renderFatal(error);
        }
      });
  }

  function logout() {
    state.session = '';
    writeSession(SESSION_KEY, '');
    loadHome().catch(renderFatal);
  }

  function renderAdmin(admin, tab) {
    tab = tab || (Object.keys(admin.actions).length ? 'actions' : 'workflows');
    var keys = Object.keys(admin.actions).sort();
    var opened = {};
    admin.openedHere.forEach(function (k) { opened[k] = true; });
    var signedInOnly = admin.signedInOnly !== false;
    var dirty = false;
    var status = h('div');
    var bar = h('div');

    function markDirty() {
      dirty = true;
      bar.replaceChildren(h('div', { class: 'savebar' }, [
        h('span', { text: 'Modifications des accès de ce document non enregistrées.' }),
        button([icon('check', 'icon--sm'), 'Enregistrer les accès'], saveAccess)
      ]));
    }

    function saveAccess() {
      var chosen = keys.filter(function (k) { return opened[k]; });
      api('POST', 'api/admin/access', { actions: chosen, signedInOnly: signedInOnly }, true).then(function (r) {
        dirty = false;
        bar.replaceChildren();
        var n = r.openedHere.length;
        status.replaceChildren(notice('ok', n
          ? (n === 1 ? '1 action ouverte' : n + ' actions ouvertes') + ' à ' + (r.signedInOnly ? 'toute personne connectée ayant accès' : 'toute personne ayant accès, même anonyme,') + ' à ce document.'
          : 'Aucune action ouverte dans ce document.'));
        return api('GET', 'api/catalog').then(function (c) { state.catalog = c; });
      }, function (e) { status.replaceChildren(notice('err', e.message)); });
    }

    function actionsTab() {
      if (!keys.length) {
        return h('div', { class: 'empty' }, [icon('flow'), h('strong', { text: 'Aucune action pour l\'instant' }),
          h('span', { text: 'Choisissez un workflow dans l\'onglet « Workflows n8n » pour créer la première.' }),
          button('Voir les workflows', function () { renderAdmin(admin, 'workflows'); }, 'ghost')]);
      }
      var list = h('ul', { class: 'list' }, keys.map(function (key) {
        var a = admin.actions[key];
        var removeBtn = button([icon('trash', 'icon--sm')], function () {
          if (removeBtn.getAttribute('data-confirm') !== 'oui') {
            removeBtn.setAttribute('data-confirm', 'oui');
            removeBtn.replaceChildren(icon('trash', 'icon--sm'), document.createTextNode('Retirer partout ?'));
            return;
          }
          api('DELETE', 'api/admin/action', { key: key }, true).then(function () { renderConfig('actions'); }, function (e) { status.replaceChildren(notice('err', e.message)); });
        }, 'danger sm', { 'aria-label': 'Retirer l\'action « ' + a.formdef.title + ' »' });
        return h('li', { class: 'list-item' }, [
          h('span', { class: 'list-item__icon', 'aria-hidden': 'true' }, [actionIcon(a)]),
          h('div', {}, [
            h('div', { class: 'list-item__title' }, [a.formdef.title].concat(accessChips(a))),
            h('div', { class: 'list-item__meta' }, ['Workflow « ' + a.workflowName + ' » · ', h('span', { class: 'mono', text: key })])
          ]),
          h('div', { class: 'list-item__side' }, [
            switchInput('ouvrir-' + key, opened[key], 'Ouverte ici', null, function (v) { opened[key] = v; markDirty(); }),
            button([icon('pencil', 'icon--sm'), 'Modifier'], function () { openEditor(Object.assign({ key: key, existing: true }, a)); }, 'ghost sm'),
            removeBtn
          ])
        ]);
      }));
      return [
        list,
        h('section', { class: 'card' }, [
          switchInput('comptes-connectes', signedInOnly, 'Réservé aux comptes Grist connectés (recommandé)',
            'Si le document est public, ses visiteurs anonymes ne voient ni ne lancent rien.', function (v) { signedInOnly = v; markDirty(); })
        ])
      ];
    }

    function workflowsTab() {
      var help = h('section', { class: 'card' }, [
        h('h2', { class: 'card__title' }, [icon('info'), 'Rendre un workflow disponible']),
        h('ol', { class: 'result__list' }, [
          h('li', { text: 'Son déclencheur est un nœud Webhook en méthode POST.' }),
          h('li', { text: 'Authentication : Header Auth, avec le credential « ' + admin.credential.name + ' », créé pour vous dans n8n. Un appel direct au webhook est alors refusé.' }),
          h('li', { text: 'Le workflow est publié.' })
        ])
      ]);
      var list = h('ul', { class: 'list' }, admin.workflows.map(function (wf) {
        var triggers = wf.triggers.length ? wf.triggers.map(function (t) {
          return h('div', { class: 'trigger' }, [
            h('span', { class: 'chip mono', text: t.method + ' /' + (t.path || '?') }),
            t.blocker
              ? h('span', { class: 'trigger__reason' }, [icon('alert', 'icon--sm'), t.blocker])
              : button([icon('plus', 'icon--sm'), 'Créer une action'], function () {
                  api('POST', 'api/admin/draft', { workflowId: wf.id, node: t.node }, true).then(function (draft) {
                    openEditor({ key: draft.key, workflowId: wf.id, node: t.node, icon: '', formdef: draft.formdef, gristAccess: 'none', writeBack: null, existing: false });
                  }, function (e) { status.replaceChildren(notice('err', e.message)); });
                }, 'sm')
          ]);
        }) : [h('div', { class: 'trigger' }, [h('span', { class: 'trigger__reason' }, [icon('alert', 'icon--sm'), 'Pas de déclencheur Webhook : ce workflow ne peut pas devenir une action.'])])];
        return h('li', { class: 'list-item' }, [
          h('span', { class: 'list-item__icon', 'aria-hidden': 'true' }, [icon('flow')]),
          h('div', {}, [
            h('div', { class: 'list-item__title' }, [wf.name, wf.published ? chip('Publié', 'ok') : chip('Non publié', 'warn'),
              wf.exposedAs.length ? chip(wf.exposedAs.length === 1 ? '1 action' : wf.exposedAs.length + ' actions', 'accent') : null]),
            triggers
          ]),
          h('div', { class: 'list-item__side' })
        ]);
      }));
      return [list, help];
    }

    var tabs = h('div', { class: 'tabs', role: 'tablist' }, [
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === 'actions'), onclick: function () { if (tab !== 'actions') renderAdmin(admin, 'actions'); } },
        ['Actions exposées', h('span', { class: 'count', text: String(keys.length) })]),
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === 'workflows'), onclick: function () { if (tab !== 'workflows') renderAdmin(admin, 'workflows'); } },
        ['Workflows n8n', h('span', { class: 'count', text: String(admin.workflows.length) })])
    ]);

    shell([
      pageHead('Configurer le portail', 'Choisissez les workflows mis à disposition, réglez leur formulaire et ouvrez-les dans ce document.',
        h('div', { class: 'row' }, [chip('Connecté à n8n', 'ok', 'check'), button([icon('logout', 'icon--sm'), 'Se déconnecter'], logout, 'quiet sm')])),
      tabs,
      status,
      tab === 'actions' ? actionsTab() : workflowsTab(),
      bar
    ]);
  }

  // ── Éditeur de formulaire ────────────────────────────────────────────────

  var KINDS = [
    { id: 'short', label: 'Texte court', type: 'Text', widget: 'text', icon: 'text' },
    { id: 'long', label: 'Texte long', type: 'Text', widget: 'textarea', icon: 'lines' },
    { id: 'number', label: 'Nombre', type: 'Numeric', widget: 'number', icon: 'hash' },
    { id: 'date', label: 'Date', type: 'Date', widget: 'date', icon: 'calendar' },
    { id: 'datetime', label: 'Date et heure', type: 'DateTime', widget: 'datetime', icon: 'calendar' },
    { id: 'select', label: 'Liste déroulante', type: 'Choice', widget: 'select', icon: 'list', choices: true },
    { id: 'radio', label: 'Choix unique', type: 'Choice', widget: 'radio', icon: 'radio', choices: true },
    { id: 'multi', label: 'Choix multiples', type: 'ChoiceList', widget: 'multiselect', icon: 'checks', choices: true },
    { id: 'bool', label: 'Oui / non', type: 'Bool', widget: 'checkbox', icon: 'toggle' },
    { id: 'scale', label: 'Échelle de 1 à 5', type: 'Int', widget: 'likert', icon: 'scale' }
  ];

  var RENDERS = [
    { value: 'text', label: 'Texte' },
    { value: 'markdown', label: 'Texte mis en forme' },
    { value: 'number', label: 'Nombre' },
    { value: 'badge', label: 'Statut' },
    { value: 'link', label: 'Lien' },
    { value: 'list', label: 'Liste' },
    { value: 'datetime', label: 'Date' },
    { value: 'json', label: 'Données brutes' }
  ];

  var OPERATORS = [
    { value: '==', label: 'est' },
    { value: '!=', label: 'n\'est pas' },
    { value: 'contains', label: 'contient' },
    { value: 'truthy', label: 'est rempli' }
  ];

  function kindById(id) { return KINDS.filter(function (k) { return k.id === id; })[0] || KINDS[0]; }

  function kindOf(f) {
    var match = KINDS.filter(function (k) { return k.type === f.type && k.widget === f.widget; })[0];
    if (match) return match.id;
    return f.widget === 'textarea' ? 'long' : f.type === 'Choice' ? 'select' : 'short';
  }

  function slugify(text) {
    var s = String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    if (!s) s = 'champ';
    if (/^[0-9]/.test(s)) s = 'c_' + s;
    return s;
  }

  // Affichage proposé pour une clé du retour, d'après la valeur reçue à l'essai.
  function guessRender(key, value) {
    if (key === 'success' || typeof value === 'boolean') return 'badge';
    if (typeof value === 'number') return 'number';
    if (Array.isArray(value)) return 'list';
    if (value && typeof value === 'object') return 'json';
    if (typeof value === 'string') {
      if (/^https?:\/\/\S+$/.test(value.trim())) return 'link';
      if (/\n/.test(value) || /(\*\*|^#{1,3}\s|^\s*[-*]\s)/m.test(value)) return 'markdown';
    }
    return 'text';
  }

  function humanize(name) {
    var s = String(name).replace(/[_-]+/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : name;
  }

  // Formulaire FormDef → modèle d'édition (et retour). Le modèle garde des
  // identifiants internes pour les listes ; ils ne sont jamais enregistrés.
  function toModel(input) {
    var fd = input.formdef || {};
    var choicesOf = function (f) {
      var list = (f.options && f.options.choices) || (fd.choices && fd.choices[(f.options && f.options.choicesKey) || f.colId]) || [];
      return list.map(function (c) { return c && typeof c === 'object' ? String(c.value) : String(c); });
    };
    var sections = fd.sections && fd.sections.length ? fd.sections : [{ id: 'saisie', label: 'Votre demande', fields: [] }];
    var wb = input.writeBack || null;
    return {
      key: input.key,
      existing: !!input.existing,
      keyEdited: !!input.existing,
      workflowId: input.workflowId,
      node: input.node,
      icon: input.icon || '',
      title: fd.title || '',
      description: fd.description || '',
      steps: sections.map(function (s) {
        return {
          uid: uid(),
          id: s.id,
          label: s.label || '',
          condition: s.condition || null,
          fields: (s.fields || []).map(function (f) {
            var cond = f.condition || null;
            var simple = cond && !cond.op && cond.field ? { field: cond.field, operator: cond.operator || '==', value: cond.value == null ? '' : cond.value } : null;
            return {
              uid: uid(), open: false, keyEdited: true,
              label: f.label || '', key: f.colId, kind: kindOf(f), required: !!f.required,
              placeholder: (f.options && f.options.placeholder) || '',
              choices: choicesOf(f),
              condition: simple,
              rawCondition: cond && !simple ? cond : null
            };
          })
        };
      }),
      outputs: ((fd.result && fd.result.fields) || []).map(function (o) { return { uid: uid(), key: o.key, label: o.label || '', render: o.render || 'text' }; }),
      gristAccess: input.gristAccess || 'none',
      writeBack: { enabled: !!wb, tableId: wb ? wb.tableId : '', fields: wb ? Object.assign({}, wb.fields) : {} },
      lastKeys: []
    };
  }

  function toFormDef(m) {
    return {
      manifest_version: '1.1.0',
      id: m.key,
      title: m.title.trim(),
      description: m.description.trim(),
      target: { kind: 'action', action: m.key },
      sections: m.steps.map(function (s, i) {
        var section = {
          id: s.id || ('etape_' + (i + 1)),
          label: s.label.trim() || ('Étape ' + (i + 1)),
          fields: s.fields.map(function (f) {
            var k = kindById(f.kind);
            var options = {};
            if (f.placeholder && (f.kind === 'short' || f.kind === 'long' || f.kind === 'number')) options.placeholder = f.placeholder;
            if (k.choices) options.choices = f.choices.filter(function (c) { return c.trim(); });
            var condition = f.condition && f.condition.field
              ? { field: f.condition.field, operator: f.condition.operator, value: f.condition.operator === 'truthy' ? true : f.condition.value }
              : f.rawCondition;
            return {
              colId: f.key, label: f.label.trim() || humanize(f.key), type: k.type, widget: k.widget,
              required: !!f.required, options: options, condition: condition || null,
              cascade: null, dynamicFilter: null, profile: null, theme: null, polarity: ''
            };
          })
        };
        if (s.condition) section.condition = s.condition;
        return section;
      }),
      choices: {},
      result: { fields: m.outputs.map(function (o) { return { key: o.key.trim(), label: o.label.trim() || humanize(o.key), render: o.render }; }) }
    };
  }

  function allFields(m) {
    return m.steps.reduce(function (acc, s) { return acc.concat(s.fields); }, []);
  }

  function uniqueKey(m, base, except) {
    var taken = allFields(m).filter(function (f) { return f !== except; }).map(function (f) { return f.key; });
    var key = base;
    for (var i = 2; taken.indexOf(key) !== -1; i += 1) key = base + '_' + i;
    return key;
  }

  function validateModel(m) {
    var errors = [];
    if (!m.title.trim()) errors.push('Donnez un titre à l\'action.');
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(m.key)) errors.push('Identifiant de l\'action : minuscules, chiffres, « - » et « _ ».');
    var seen = {};
    allFields(m).forEach(function (f) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(f.key)) errors.push('Clé invalide pour « ' + (f.label || f.key) + ' » : lettres, chiffres et « _ ».');
      else if (seen[f.key]) errors.push('Deux champs utilisent la clé « ' + f.key + ' ».');
      seen[f.key] = true;
      if (kindById(f.kind).choices && !f.choices.filter(function (c) { return c.trim(); }).length) errors.push('« ' + (f.label || f.key) + ' » : ajoutez au moins un choix.');
    });
    var outSeen = {};
    m.outputs.forEach(function (o) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(o.key.trim())) errors.push('Clé de résultat invalide : « ' + o.key + ' ».');
      else if (outSeen[o.key]) errors.push('Clé de résultat en double : « ' + o.key + ' ».');
      outSeen[o.key] = true;
    });
    if (m.writeBack.enabled) {
      if (!m.writeBack.tableId) errors.push('Choisissez la table où enregistrer le résultat.');
      var mapped = Object.keys(m.writeBack.fields).filter(function (k) { return m.writeBack.fields[k]; });
      if (!mapped.length) errors.push('Associez au moins une clé du résultat à une colonne.');
    }
    return errors;
  }

  function openEditor(input) {
    var wf = state.admin && state.admin.workflows.filter(function (w) { return String(w.id) === String(input.workflowId); })[0];
    renderEditor(toModel(input), (wf && wf.inputs) || []);
  }

  function renderEditor(m, workflowInputs) {
    state.mode = 'config';
    var dirty = false;
    var feedback = h('div');
    var cards = { form: h('section', { class: 'card' }), outputs: h('section', { class: 'card' }), doc: h('section', { class: 'card' }) };
    var previewHost = h('div');
    var previewResult = h('div');
    var tables = null;
    var columns = {};
    keepFocusOnButtons(previewHost);

    var schedulePreview = debounce(paintPreview, 350);
    function changed() { dirty = true; schedulePreview(); }

    // Présentation de l'action.
    var iconTile = h('span', { class: 'icon-tile', 'aria-hidden': 'true' });
    function paintIcon() { iconTile.replaceChildren(m.icon ? document.createTextNode(m.icon) : icon('bolt', 'icon--lg')); }
    paintIcon();
    var keyInput = h('input', { class: 'input input--mono', id: 'ed-cle', value: m.key, disabled: m.existing });
    keyInput.addEventListener('input', function () { m.key = keyInput.value.trim(); m.keyEdited = true; changed(); });
    var titleInput = h('input', { class: 'input', id: 'ed-titre', value: m.title, placeholder: 'Analyser une page web' });
    titleInput.addEventListener('input', function () {
      m.title = titleInput.value;
      if (!m.existing && !m.keyEdited) {
        m.key = slugify(m.title).replace(/_/g, '-').slice(0, 48) || m.key;
        keyInput.value = m.key;
      }
      changed();
    });
    var descInput = h('textarea', { class: 'textarea', id: 'ed-desc', rows: '2', placeholder: 'Ce que fait l\'action, en une phrase.' });
    descInput.value = m.description;
    descInput.addEventListener('input', function () { m.description = descInput.value; changed(); });
    var iconInput = h('input', { class: 'input', id: 'ed-icone', value: m.icon, maxlength: '4' });
    iconInput.addEventListener('input', function () { m.icon = iconInput.value.trim(); paintIcon(); changed(); });

    var presentation = h('section', { class: 'card' }, [
      h('div', { class: 'card__head' }, [h('h2', { class: 'card__title' }, [icon('bolt'), 'Présentation'])]),
      h('div', { class: 'row row--top' }, [iconTile, h('div', { class: 'field grow' }, [h('label', { for: 'ed-titre', text: 'Titre' }), titleInput])]),
      field('Description', descInput, 'Affichée sur la carte de l\'action et en tête du formulaire.'),
      h('div', { class: 'grid-2' }, [
        field('Icône', iconInput, 'Un emoji, ou vide pour l\'icône par défaut.'),
        field('Identifiant', keyInput, m.existing ? 'Fixé à la création.' : 'Suit le titre tant que vous ne le modifiez pas.')
      ])
    ]);

    // Formulaire : étapes et champs.
    function addField(step, kindId, key, label) {
      var k = kindById(kindId);
      var base = key || slugify(label || k.label);
      var f = {
        uid: uid(), open: !key, keyEdited: !!key, label: label || (key ? humanize(key) : ''), key: uniqueKey(m, base),
        kind: k.id, required: false, placeholder: '', choices: k.choices ? ['Option 1', 'Option 2'] : [], condition: null, rawCondition: null
      };
      step.fields.push(f);
      paintForm();
      changed();
      return f;
    }

    function move(list, item, delta) {
      var i = list.indexOf(item);
      var j = i + delta;
      if (j < 0 || j >= list.length) return;
      list.splice(i, 1);
      list.splice(j, 0, item);
    }

    function fieldCard(step, f) {
      var k = kindById(f.kind);
      var nameEl = h('span', { class: 'fcard__name', text: f.label || 'Sans titre' });
      var keyEl = h('span', { class: 'fcard__key', text: f.key });
      var card = h('div', { class: 'fcard', 'data-open': String(f.open) });
      var head = h('div', { class: 'fcard__head' }, [
        h('button', { type: 'button', class: 'fcard__toggle', 'aria-expanded': String(f.open), onclick: function () { f.open = !f.open; paintForm(); } }, [
          icon(k.icon, 'icon--sm'), nameEl, f.required ? h('span', { class: 'fcard__req', title: 'Obligatoire', text: '*' }) : null, keyEl
        ]),
        h('div', { class: 'fcard__tools' }, [
          button([icon('up', 'icon--sm')], function () { move(step.fields, f, -1); paintForm(); changed(); }, 'quiet icon', { 'aria-label': 'Monter' }),
          button([icon('down', 'icon--sm')], function () { move(step.fields, f, 1); paintForm(); changed(); }, 'quiet icon', { 'aria-label': 'Descendre' }),
          button([icon('trash', 'icon--sm')], function () { step.fields.splice(step.fields.indexOf(f), 1); paintForm(); changed(); }, 'quiet icon', { 'aria-label': 'Supprimer le champ' })
        ])
      ]);
      card.appendChild(head);
      if (!f.open) return card;

      var id = 'f-' + f.uid;
      var label = h('input', { class: 'input', id: id + '-lib', value: f.label, placeholder: 'Votre question' });
      var key = h('input', { class: 'input input--mono', id: id + '-cle', value: f.key });
      var keyHint = h('span', { class: 'field__hint' });
      function paintKeyHint() {
        keyHint.textContent = workflowInputs.length && workflowInputs.indexOf(f.key) === -1
          ? 'Le workflow ne lit pas « ' + f.key + ' » d\'après son contenu : vérifiez la clé.'
          : 'Nom du champ reçu par le workflow : $json.body.' + f.key;
      }
      paintKeyHint();
      label.addEventListener('input', function () {
        f.label = label.value;
        nameEl.textContent = f.label || 'Sans titre';
        if (!f.keyEdited) { f.key = uniqueKey(m, slugify(f.label), f); key.value = f.key; keyEl.textContent = f.key; paintKeyHint(); }
        changed();
      });
      key.addEventListener('input', function () { f.key = key.value.trim(); f.keyEdited = true; keyEl.textContent = f.key; paintKeyHint(); changed(); });
      var kindSelect = h('select', { class: 'select', id: id + '-type' }, KINDS.map(function (kk) { return h('option', { value: kk.id, text: kk.label }); }));
      kindSelect.value = f.kind;
      kindSelect.addEventListener('change', function () {
        f.kind = kindSelect.value;
        if (kindById(f.kind).choices && !f.choices.length) f.choices = ['Option 1', 'Option 2'];
        paintForm();
        changed();
      });

      var body = h('div', { class: 'fcard__body' }, [
        h('div', { class: 'grid-2' }, [
          field('Libellé', label),
          field('Type', kindSelect),
          h('div', { class: 'field' }, [h('label', { for: id + '-cle', text: 'Clé' }), key, keyHint])
        ]),
        switchInput(id + '-req', f.required, 'Obligatoire', f.kind === 'bool' ? 'La case devra être cochée pour envoyer.' : null, function (v) {
          f.required = v; paintForm(); changed();
        })
      ]);

      if (f.kind === 'short' || f.kind === 'long' || f.kind === 'number') {
        var ph = h('input', { class: 'input', id: id + '-ex', value: f.placeholder, placeholder: 'ex. : https://www.service-public.fr/…' });
        ph.addEventListener('input', function () { f.placeholder = ph.value; changed(); });
        body.appendChild(field('Texte d\'exemple', ph, 'Affiché en gris dans le champ vide, pour guider la saisie.'));
      }
      if (kindById(f.kind).choices) {
        var choices = h('textarea', { class: 'textarea', id: id + '-choix', rows: '4' });
        choices.value = f.choices.join('\n');
        choices.addEventListener('input', function () { f.choices = choices.value.split('\n'); changed(); });
        body.appendChild(field('Choix proposés', choices, 'Un par ligne.'));
      }
      if (m.steps.length > 1) {
        var stepSelect = h('select', { class: 'select', id: id + '-etape' }, m.steps.map(function (s, i) { return h('option', { value: s.uid, text: 'Étape ' + (i + 1) + (s.label ? ' — ' + s.label : '') }); }));
        stepSelect.value = step.uid;
        stepSelect.addEventListener('change', function () {
          var target = m.steps.filter(function (s) { return s.uid === stepSelect.value; })[0];
          step.fields.splice(step.fields.indexOf(f), 1);
          target.fields.push(f);
          paintForm();
          changed();
        });
        body.appendChild(field('Étape', stepSelect));
      }

      // Condition d'affichage simple : un autre champ, un opérateur, une valeur.
      var others = allFields(m).filter(function (o) { return o !== f; });
      if (f.rawCondition) {
        body.appendChild(notice('info', 'Condition d\'affichage avancée : modifiable dans le JSON.'));
      } else if (others.length) {
        var condHost = h('div', { class: 'grid-2' });
        var paintCond = function () {
          condHost.replaceChildren();
          if (!f.condition) return;
          var src = h('select', { class: 'select', id: id + '-si' }, others.map(function (o) { return h('option', { value: o.key, text: o.label || o.key }); }));
          if (!others.some(function (o) { return o.key === f.condition.field; })) f.condition.field = others[0].key;
          src.value = f.condition.field;
          var op = h('select', { class: 'select', id: id + '-op' }, OPERATORS.map(function (o) { return h('option', { value: o.value, text: o.label }); }));
          op.value = f.condition.operator;
          var source = others.filter(function (o) { return o.key === f.condition.field; })[0];
          var val;
          if (kindById(source.kind).choices) {
            val = h('select', { class: 'select', id: id + '-val' }, source.choices.filter(function (c) { return c.trim(); }).map(function (c) { return h('option', { value: c, text: c }); }));
            if (!f.condition.value) f.condition.value = source.choices[0] || '';
          } else if (source.kind === 'bool') {
            val = h('select', { class: 'select', id: id + '-val' }, [h('option', { value: 'true', text: 'coché' }), h('option', { value: 'false', text: 'non coché' })]);
          } else {
            val = h('input', { class: 'input', id: id + '-val' });
          }
          val.value = f.condition.value;
          src.addEventListener('change', function () { f.condition.field = src.value; f.condition.value = ''; paintCond(); changed(); });
          op.addEventListener('change', function () { f.condition.operator = op.value; paintCond(); changed(); });
          val.addEventListener('input', function () { f.condition.value = source.kind === 'bool' ? val.value === 'true' : val.value; changed(); });
          val.addEventListener('change', function () { f.condition.value = source.kind === 'bool' ? val.value === 'true' : val.value; changed(); });
          condHost.appendChild(field('Si le champ', src));
          condHost.appendChild(field('Condition', op));
          if (f.condition.operator !== 'truthy') condHost.appendChild(field('Valeur', val));
        };
        body.appendChild(switchInput(id + '-cond', !!f.condition, 'Afficher seulement sous condition', null, function (v) {
          f.condition = v ? { field: others[0].key, operator: '==', value: '' } : null;
          paintCond();
          changed();
        }));
        body.appendChild(condHost);
        paintCond();
      }
      card.appendChild(body);
      return card;
    }

    function paintForm() {
      var used = allFields(m).map(function (f) { return f.key; });
      var missing = workflowInputs.filter(function (n) { return used.indexOf(n) === -1; });
      fill(cards.form, 
        h('div', { class: 'card__head' }, [h('div', {}, [
          h('h2', { class: 'card__title' }, [icon('lines'), 'Formulaire']),
          h('p', { class: 'card__sub', text: 'Ce que le demandeur remplit, étape par étape.' })
        ])]),
        missing.length ? h('div', { class: 'suggest' }, ['Lus par le workflow :'].concat(missing.map(function (name) {
          return h('button', { type: 'button', class: 'chip chip--accent', onclick: function () {
            addField(m.steps[m.steps.length - 1], /texte|text|prompt|description|consigne|contenu|message|question/i.test(name) ? 'long' : 'short', name);
          } }, [icon('plus', 'icon--sm'), name]);
        }))) : null,
        m.steps.map(function (step, i) {
          var menuHost = h('div');
          var title = h('input', { class: 'input step__title', id: 'etape-' + step.uid, value: step.label, placeholder: 'Titre de l\'étape', 'aria-label': 'Titre de l\'étape ' + (i + 1) });
          title.addEventListener('input', function () { step.label = title.value; changed(); });
          return h('div', { class: 'step' }, [
            h('div', { class: 'step__head' }, [
              h('span', { class: 'step__num', text: m.steps.length > 1 ? 'Étape ' + (i + 1) : 'Étape' }), title,
              m.steps.length > 1 ? h('div', { class: 'fcard__tools' }, [
                button([icon('up', 'icon--sm')], function () { move(m.steps, step, -1); paintForm(); changed(); }, 'quiet icon', { 'aria-label': 'Monter l\'étape' }),
                button([icon('down', 'icon--sm')], function () { move(m.steps, step, 1); paintForm(); changed(); }, 'quiet icon', { 'aria-label': 'Descendre l\'étape' }),
                button([icon('trash', 'icon--sm')], function () {
                  var target = m.steps[i === 0 ? 1 : i - 1];
                  target.fields = target.fields.concat(step.fields);
                  m.steps.splice(i, 1);
                  paintForm();
                  changed();
                }, 'quiet icon', { 'aria-label': 'Supprimer l\'étape (ses champs passent à la voisine)' })
              ]) : null
            ]),
            h('div', { class: 'fields' }, step.fields.map(function (f) { return fieldCard(step, f); })),
            menuHost,
            h('div', {}, [button([icon('plus', 'icon--sm'), 'Ajouter un champ'], function () {
              if (menuHost.firstChild) { menuHost.replaceChildren(); return; }
              menuHost.replaceChildren(h('div', { class: 'kind-menu' }, KINDS.map(function (kk) {
                return h('button', { type: 'button', onclick: function () { addField(step, kk.id); } }, [icon(kk.icon, 'icon--sm'), kk.label]);
              })));
            }, 'ghost sm')])
          ]);
        }),
        h('div', {}, [button([icon('plus', 'icon--sm'), 'Ajouter une étape'], function () {
          m.steps.push({ uid: uid(), id: 'etape_' + (m.steps.length + 1), label: '', condition: null, fields: [] });
          paintForm();
          changed();
        }, 'quiet sm')])
      );
    }

    // Résultat affiché.
    function paintOutputs() {
      var declared = m.outputs.map(function (o) { return o.key; });
      var suggestions = m.lastKeys.filter(function (k) { return declared.indexOf(k) === -1; });
      fill(cards.outputs, 
        h('div', {}, [
          h('h2', { class: 'card__title' }, [icon('eye'), 'Résultat affiché']),
          h('p', { class: 'card__sub', text: 'Les clés du retour du workflow que le demandeur voit. Sans clé déclarée, tout le retour est affiché.' })
        ]),
        suggestions.length ? h('div', { class: 'suggest' }, ['Reçues au dernier essai :'].concat(suggestions.map(function (k) {
          return h('button', { type: 'button', class: 'chip chip--accent', onclick: function () {
            m.outputs.push({ uid: uid(), key: k, label: humanize(k), render: guessRender(k, m.lastResult ? m.lastResult[k] : undefined) });
            paintOutputs(); paintDoc(); changed();
          } }, [icon('plus', 'icon--sm'), k]);
        }))) : (m.lastKeys.length ? null : h('p', { class: 'field__hint', text: 'Astuce : envoyez l\'aperçu pour essayer l\'action ; les clés reçues s\'ajoutent ici en un clic.' })),
        m.outputs.map(function (o) {
          var id = 'o-' + o.uid;
          var k = h('input', { class: 'input input--mono', id: id + '-cle', value: o.key, 'aria-label': 'Clé' });
          k.addEventListener('input', function () { o.key = k.value.trim(); changed(); });
          var l = h('input', { class: 'input', id: id + '-lib', value: o.label, 'aria-label': 'Libellé affiché' });
          l.addEventListener('input', function () { o.label = l.value; changed(); });
          var r = h('select', { class: 'select', id: id + '-rendu', 'aria-label': 'Affichage' }, RENDERS.map(function (x) { return h('option', { value: x.value, text: x.label }); }));
          r.value = o.render;
          r.addEventListener('change', function () { o.render = r.value; changed(); });
          return h('div', { class: 'out-row' }, [k, l, r, h('div', { class: 'fcard__tools' }, [
            button([icon('up', 'icon--sm')], function () { move(m.outputs, o, -1); paintOutputs(); changed(); }, 'quiet icon', { 'aria-label': 'Monter' }),
            button([icon('trash', 'icon--sm')], function () { m.outputs.splice(m.outputs.indexOf(o), 1); paintOutputs(); paintDoc(); changed(); }, 'quiet icon', { 'aria-label': 'Retirer' })
          ])]);
        }),
        h('div', {}, [button([icon('plus', 'icon--sm'), 'Ajouter une clé'], function () {
          m.outputs.push({ uid: uid(), key: '', label: '', render: 'text' });
          paintOutputs();
        }, 'ghost sm')])
      );
    }

    // Accès au document et enregistrement du résultat.
    var ACCESS_TEXT = {
      none: 'Le workflow ne reçoit aucun accès au document.',
      read: 'Le workflow reçoit un jeton du demandeur, valable quelques minutes, pour lire ce document avec ses droits ($json.body._portail.grist).',
      write: 'Le workflow reçoit un jeton du demandeur, valable quelques minutes, pour lire et modifier ce document avec ses droits ($json.body._portail.grist).'
    };

    function loadTables() {
      if (tables) return Promise.resolve(tables);
      return window.grist.docApi.listTables().then(function (list) { tables = list; return list; });
    }

    function loadColumns(tableId) {
      if (columns[tableId]) return Promise.resolve(columns[tableId]);
      return window.grist.docApi.fetchTable(tableId).then(function (data) {
        columns[tableId] = Object.keys(data).filter(function (c) { return c !== 'id' && c !== 'manualSort' && c.indexOf('gristHelper_') !== 0; });
        return columns[tableId];
      });
    }

    function paintDoc() {
      var accessText = h('p', { class: 'field__hint', text: ACCESS_TEXT[m.gristAccess] });
      var wbHost = h('div', { class: 'fields' });
      var paintWb = function () {
        wbHost.replaceChildren();
        if (!m.writeBack.enabled) return;
        var tableSelect = h('select', { class: 'select', id: 'wb-table' }, [h('option', { value: '', text: 'Choisir une table…' })]);
        wbHost.appendChild(field('Table du document', tableSelect));
        var mapHost = h('div', { class: 'fields' });
        wbHost.appendChild(mapHost);
        loadTables().then(function (list) {
          list.forEach(function (t) { tableSelect.appendChild(h('option', { value: t, text: t })); });
          tableSelect.value = m.writeBack.tableId || '';
          paintMap();
        }, function () { wbHost.appendChild(notice('warn', 'Impossible de lire les tables de ce document.')); });
        tableSelect.addEventListener('change', function () { m.writeBack.tableId = tableSelect.value; m.writeBack.fields = {}; paintMap(); changed(); });
        function paintMap() {
          mapHost.replaceChildren();
          if (!m.writeBack.tableId) return;
          var keys = m.outputs.length ? m.outputs.map(function (o) { return o.key; }).filter(Boolean) : m.lastKeys;
          if (!keys.length) { mapHost.appendChild(h('p', { class: 'field__hint', text: 'Déclarez des clés de résultat, ou faites un essai, pour les associer à des colonnes.' })); return; }
          loadColumns(m.writeBack.tableId).then(function (cols) {
            keys.forEach(function (key) {
              var sel = h('select', { class: 'select', 'aria-label': 'Colonne pour ' + key }, [h('option', { value: '', text: 'Ne pas enregistrer' })].concat(cols.map(function (c) { return h('option', { value: c, text: c }); })));
              sel.value = m.writeBack.fields[key] || '';
              sel.addEventListener('change', function () {
                if (sel.value) m.writeBack.fields[key] = sel.value; else delete m.writeBack.fields[key];
                changed();
              });
              mapHost.appendChild(h('div', { class: 'map-row' }, [h('span', { class: 'chip mono', text: key }), icon('arrow', 'icon--sm'), sel]));
            });
          });
        }
      };
      fill(cards.doc, 
        h('div', {}, [
          h('h2', { class: 'card__title' }, [icon('doc'), 'Document Grist']),
          h('p', { class: 'card__sub', text: 'Ce que l\'action peut faire dans le document où elle est lancée.' })
        ]),
        h('div', { class: 'field' }, [
          h('span', { class: 'field__label', text: 'Accès pendant l\'exécution' }),
          segmented([{ value: 'none', label: 'Aucun' }, { value: 'read', label: 'Lecture' }, { value: 'write', label: 'Écriture' }], m.gristAccess, function (v) {
            m.gristAccess = v; accessText.textContent = ACCESS_TEXT[v]; changed();
          }),
          accessText
        ]),
        switchInput('wb-actif', m.writeBack.enabled, 'Enregistrer le résultat dans une table', 'Le widget écrit une ligne avec les droits du demandeur.', function (v) {
          m.writeBack.enabled = v; paintWb(); changed();
        }),
        wbHost
      );
      paintWb();
    }

    // Aperçu vivant, qui sert aussi d'essai réel.
    function paintPreview() {
      var fd = toFormDef(m);
      previewHost.replaceChildren();
      try {
        window.FormEngine.mount(previewHost, fd, {
          skipProbe: true,
          submit: function (data) {
            var stop = progress(previewResult);
            return api('POST', 'api/admin/try', { workflowId: m.workflowId, node: m.node, formdef: fd, inputs: data }, true).then(function (r) {
              stop();
              m.lastKeys = r.keys || [];
              m.lastResult = r.result || {};
              paintOutputs();
              paintDoc();
              setTimeout(function () {
                // Le message de succès générique du moteur laisse place au retour.
                previewHost.replaceChildren();
                previewResult.replaceChildren(
                  notice('ok', 'Essai réussi en ' + Math.max(1, Math.round(r.durationMs / 1000)) + ' s. Voici tout le retour du workflow ; le demandeur ne verra que les clés déclarées.'),
                  resultBlocks(r.result, null),
                  button([icon('eye', 'icon--sm'), 'Revenir à l\'aperçu'], function () { previewResult.replaceChildren(); paintPreview(); }, 'ghost sm')
                );
              }, 0);
              return r;
            }, function (e) { stop(); throw e; });
          }
        });
      } catch (e) {
        previewHost.replaceChildren(notice('warn', 'Aperçu impossible : ' + e.message));
      }
    }

    function save() {
      var errors = validateModel(m);
      if (errors.length) { feedback.replaceChildren(notice('err', 'Le formulaire n\'est pas encore prêt.', errors)); window.scrollTo(0, 0); return; }
      var wb = null;
      if (m.writeBack.enabled) {
        var mapped = {};
        Object.keys(m.writeBack.fields).forEach(function (k) { if (m.writeBack.fields[k]) mapped[k] = m.writeBack.fields[k]; });
        wb = { tableId: m.writeBack.tableId, fields: mapped };
      }
      api('POST', 'api/admin/action', {
        key: m.key, workflowId: m.workflowId, node: m.node, icon: m.icon, formdef: toFormDef(m), gristAccess: m.gristAccess, writeBack: wb
      }, true).then(function (r) {
        dirty = false;
        feedback.replaceChildren(notice(r.published ? 'ok' : 'warn', r.published
          ? 'Action enregistrée. Ouvrez-la dans ce document depuis « Actions exposées ».'
          : 'Action enregistrée, mais le workflow n\'est pas publié dans n8n : elle échouera tant qu\'il ne l\'est pas.'));
        setTimeout(function () { renderConfig('actions'); }, 1100);
      }, function (e) {
        feedback.replaceChildren(notice('err', e.message, e.details));
        window.scrollTo(0, 0);
      });
    }

    function leave() {
      if (dirty && !feedback.querySelector('[data-confirm-leave]')) {
        feedback.replaceChildren(h('div', { 'data-confirm-leave': '' }, [notice('warn', 'Des modifications ne sont pas enregistrées.'),
          h('div', { class: 'row' }, [button('Quitter sans enregistrer', function () { renderConfig('actions'); }, 'danger sm'), button('Rester', function () { feedback.replaceChildren(); }, 'ghost sm')])]));
        return;
      }
      renderConfig('actions');
    }

    // JSON, pour les réglages que l'éditeur ne couvre pas.
    function openJson() {
      var area = h('textarea', { class: 'textarea json-edit', id: 'ed-json', spellcheck: 'false' });
      area.value = JSON.stringify(toFormDef(m), null, 2);
      var msg = h('div');
      shell([
        backLink('Revenir à l\'éditeur', function () { renderEditor(m, workflowInputs); }),
        pageHead('Formulaire en JSON', 'Le contrat FormDef complet. « Appliquer » reprend vos changements dans l\'éditeur.'),
        msg,
        h('section', { class: 'card' }, [area]),
        h('div', { class: 'row' }, [
          button([icon('check', 'icon--sm'), 'Appliquer'], function () {
            try {
              var fd = JSON.parse(area.value);
              var next = toModel({ key: m.key, existing: m.existing, workflowId: m.workflowId, node: m.node, icon: m.icon, formdef: fd, gristAccess: m.gristAccess, writeBack: m.writeBack.enabled ? { tableId: m.writeBack.tableId, fields: m.writeBack.fields } : null });
              next.keyEdited = m.keyEdited;
              next.lastKeys = m.lastKeys;
              next.lastResult = m.lastResult;
              renderEditor(next, workflowInputs);
            } catch (e) {
              msg.replaceChildren(notice('err', 'JSON illisible : ' + e.message));
            }
          }),
          button('Annuler', function () { renderEditor(m, workflowInputs); }, 'ghost')
        ])
      ], { wide: true });
    }

    paintForm();
    paintOutputs();
    paintDoc();
    shell([
      backLink('Configuration', leave),
      h('div', { class: 'editor-head' }, [
        h('div', {}, [
          h('h1', { class: 'editor-title', text: m.existing ? 'Modifier l\'action' : 'Nouvelle action' }),
          h('p', { class: 'card__sub' }, ['Workflow : ', h('span', { class: 'mono', text: (state.admin && (state.admin.workflows.filter(function (w) { return String(w.id) === String(m.workflowId); })[0] || {}).name) || m.workflowId })])
        ]),
        h('div', { class: 'row' }, [
          button([icon('code', 'icon--sm'), 'JSON'], openJson, 'quiet'),
          button('Annuler', leave, 'ghost'),
          button([icon('check', 'icon--sm'), 'Enregistrer'], save)
        ])
      ]),
      feedback,
      h('div', { class: 'editor' }, [
        h('div', { class: 'editor__main' }, [presentation, cards.form, cards.outputs, cards.doc]),
        h('aside', { class: 'editor__side' }, [h('section', { class: 'preview' }, [
          h('div', {}, [
            h('h2', { class: 'card__title' }, [icon('eye'), 'Aperçu et essai']),
            h('p', { class: 'preview__note' }, [icon('play', 'icon--sm'), 'Envoyer ce formulaire exécute réellement le workflow, en votre nom.'])
          ]),
          previewHost,
          previewResult
        ])])
      ])
    ], { wide: true });
    paintPreview();
  }

  // ── Démarrage ────────────────────────────────────────────────────────────

  if (!window.grist || !window.grist.docApi) {
    shell([notice('info', 'Ce portail s\'utilise comme widget personnalisé dans un document Grist, avec un accès complet au document.')]);
    return;
  }
  // Suivre le thème de Grist : clair ou sombre.
  if (typeof window.grist.onThemeChange === 'function') {
    window.grist.onThemeChange(function (theme) {
      if (theme && (theme.appearance === 'dark' || theme.appearance === 'light')) {
        document.documentElement.setAttribute('data-theme', theme.appearance);
      }
    });
  }
  window.grist.ready({ requiredAccess: 'full' });
  function looksLikeDocId(name) {
    return /^[A-Za-z0-9]{12,}$/.test(name) && /[0-9]/.test(name) && /[a-z]/.test(name) && /[A-Z]/.test(name);
  }
  if (window.grist.docApi.getDocName) {
    window.grist.docApi.getDocName().then(function (name) {
      // Selon les versions, Grist renvoie l'identifiant interne du document
      // plutôt que son titre : on ne l'affiche pas.
      if (!name || looksLikeDocId(name)) return;
      state.docName = name;
      var sub = root.querySelector('.brand__sub');
      if (sub) sub.textContent = name;
    }, function () {});
  }
  loadHome().catch(function (error) {
    if (/access|accès|permission/i.test((error && error.message) || '')) {
      renderFatal(new Error('Le widget doit avoir un accès complet au document (réglage « Accès » du widget).'));
    } else {
      renderFatal(error);
    }
  });
})();
