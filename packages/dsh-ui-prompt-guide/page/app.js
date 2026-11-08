/*
 * Prompt Guide — the static page's behaviour.
 *
 * No framework and no build step on purpose: the page is documentation, and a
 * sentence must be editable without rebuilding the client bundle. It reads
 * `/prompt-guide/api/guide` (served from `src/guide.ts`) and renders it, with
 * three small bridges to the shell:
 *
 *  - `postMessage({ type: 'prompt-guide:start', prompt })` asks the host half to
 *    open a new session with the prompt pre-filled; the reply is `start-ok` or
 *    `start-failed`;
 *  - `prompt-guide:scheme` from the host sets light/dark explicitly, because an
 *    iframe does not inherit the shell's `prefers-color-scheme`;
 *  - everything else stays inside the frame (search, filter, copy, language).
 */
;(function () {
  'use strict'

  var LANG_KEY = 'dsh-prompt-guide:lang'

  var UI = {
    zh: {
      title: '提示词引导',
      lede: '这个发行版能做什么，以及该怎么说。每张卡片都是一句可以直接发出去的话：复制它，或者在新会话里打开再补上你的对象名。',
      search: '搜索功能、工具或说法…',
      all: '全部',
      notes: '使用约定',
      copy: '复制',
      copied: '已复制',
      copyFailed: '复制失败，请手动选择',
      start: '在新会话中使用',
      starting: '正在打开…',
      startOk: '已在新会话里填好',
      startFail: '打开新会话失败',
      startUnavailable: '请从左侧栏的「提示词引导」打开本页',
      empty: '没有匹配的 Prompt。换个词试试，或点“全部”。',
      outcome: '会发生什么',
      note: '注意',
      loadFailed: '指南内容加载失败。',
      retry: '重试',
      meta: function (count, version) {
        return '提示词引导 · ' + count + ' 条 · guide v' + version + ' · dsh-automation-suite'
      },
    },
    en: {
      title: 'Prompt Guide',
      lede: 'What this distribution can do, and how to ask for it. Every card is a sentence you can send as-is: copy it, or open it in a new session and fill in your own object names.',
      search: 'Search features, tools or wording…',
      all: 'All',
      notes: 'Ground rules',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Copy failed — select the text manually',
      start: 'Use in a new session',
      starting: 'Opening…',
      startOk: 'Filled into a new session',
      startFail: 'Could not open a session',
      startUnavailable: 'Open this page from the Prompt Guide entry in the sidebar',
      empty: 'No prompt matches. Try another word, or pick “All”.',
      outcome: 'What happens',
      note: 'Note',
      loadFailed: 'The guide could not be loaded.',
      retry: 'Retry',
      meta: function (count, version) {
        return 'Prompt Guide · ' + count + ' prompts · guide v' + version + ' · dsh-automation-suite'
      },
    },
  }

  var ICONS = {
    copy:
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6a2 2 0 0 0-2 2v8.5A2.5 2.5 0 0 0 6.5 16"/></svg>',
    arrow:
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M5 12h13"/><path d="m13 7 5 5-5 5"/></svg>',
  }

  var doc = null
  var state = { lang: readLang(), query: '', category: 'all' }
  var lastStartButton = null

  var el = {
    title: document.querySelector('.pg-head h1'),
    lede: document.getElementById('lede'),
    search: document.getElementById('search'),
    nav: document.getElementById('nav'),
    notesBox: document.getElementById('notes-box'),
    notesTitle: document.getElementById('notes-title'),
    notes: document.getElementById('notes'),
    cards: document.getElementById('cards'),
    empty: document.getElementById('empty'),
    meta: document.getElementById('meta'),
  }

  function hostLang() {
    // The page is same-origin with the shell, so the shell's <html lang> is the
    // best hint about the app language on a first visit. It is only a hint: a
    // saved choice and the browser locale still win, and a cross-origin embed
    // would throw (hence the catch).
    try {
      if (window.parent !== window) {
        var lang = String(window.parent.document.documentElement.lang || '').toLowerCase()
        if (lang.indexOf('zh') === 0) return 'zh'
        if (lang.indexOf('en') === 0) return 'en'
      }
    } catch (error) {
      /* cross-origin parent */
    }
    return null
  }

  function readLang() {
    try {
      var saved = localStorage.getItem(LANG_KEY)
      if (saved === 'zh' || saved === 'en') return saved
    } catch (error) {
      /* private mode */
    }
    var hinted = hostLang()
    if (hinted !== null) return hinted
    return (navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
  }

  function t(key) {
    return UI[state.lang][key]
  }

  function text(value) {
    if (value === null || value === undefined) return ''
    if (typeof value === 'string') return value
    return value[state.lang] || value.en || value.zh || ''
  }

  function h(tag, props, children) {
    var node = document.createElement(tag)
    if (props) {
      Object.keys(props).forEach(function (name) {
        if (name === 'class') node.className = props[name]
        else if (name === 'text') node.textContent = props[name]
        else if (name === 'html') node.innerHTML = props[name]
        else node.setAttribute(name, props[name])
      })
    }
    ;(children || []).forEach(function (child) {
      if (child === null || child === undefined) return
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
    })
    return node
  }

  // -------------------------------------------------------------- rendering

  function matches(entry) {
    var q = state.query.trim().toLowerCase()
    if (q === '') return true
    var haystack = [text(entry.title), text(entry.when), text(entry.prompt), text(entry.outcome), text(entry.note || {})]
      .concat(entry.tools || [])
      .join(' ')
      .toLowerCase()
    return haystack.indexOf(q) !== -1
  }

  function visibleEntries() {
    return (doc.entries || []).filter(function (entry) {
      if (state.category !== 'all' && entry.category !== state.category) return false
      return matches(entry)
    })
  }

  function renderNav() {
    el.nav.textContent = ''
    var groups = [{ id: 'all', title: { zh: t('all'), en: t('all') } }]
    var sorted = (doc.categories || []).slice().sort(function (a, b) {
      return (a.order || 0) - (b.order || 0)
    })
    sorted.forEach(function (category) {
      groups.push(category)
    })

    groups.forEach(function (group) {
      var count = (doc.entries || []).filter(function (entry) {
        return group.id === 'all' || entry.category === group.id
      }).length
      var button = h(
        'button',
        {
          type: 'button',
          'aria-pressed': String(state.category === group.id),
        },
        [h('span', { text: text(group.title) }), h('span', { class: 'pg-count', text: String(count) })],
      )
      button.addEventListener('click', function () {
        state.category = group.id
        render()
      })
      el.nav.appendChild(button)
    })
  }

  function renderNotes() {
    if (!doc.notes || doc.notes.length === 0) {
      el.notesBox.hidden = true
      return
    }
    el.notesBox.hidden = false
    el.notesTitle.textContent = t('notes')
    el.notes.textContent = ''
    doc.notes.forEach(function (note) {
      el.notes.appendChild(h('li', null, [text(note)]))
    })
  }

  function toolChip(name) {
    var chip = h('button', {
      type: 'button',
      class: name.charAt(0) === '/' ? 'pg-tool is-command' : 'pg-tool',
      text: name,
      title: state.lang === 'zh' ? '按这个名字筛选' : 'Filter by this name',
    })
    chip.addEventListener('click', function () {
      el.search.value = name
      state.query = name
      state.category = 'all'
      render()
    })
    return chip
  }

  function actionButton(label, icon, onClick) {
    var button = h('button', { type: 'button', class: 'pg-btn', html: icon + '<span>' + escapeHtml(label) + '</span>' })
    button.addEventListener('click', function () {
      onClick(button)
    })
    return button
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function flash(button, message, ok) {
    if (!button) return
    var label = button.querySelector('span')
    if (!label) return
    if (!label.hasAttribute('data-label')) label.setAttribute('data-label', label.textContent)
    label.textContent = message
    button.setAttribute('data-state', ok ? 'done' : 'error')
    window.setTimeout(function () {
      label.textContent = label.getAttribute('data-label')
      button.removeAttribute('data-state')
    }, 2200)
  }

  function card(entry) {
    var head = h('div', { class: 'pg-card-head' }, [h('h3', null, [text(entry.title)])])
    var prompt = h('pre', { class: 'pg-prompt', text: text(entry.prompt) })

    var actions = h('div', { class: 'pg-prompt-actions' })
    actions.appendChild(
      actionButton(t('copy'), ICONS.copy, function (button) {
        copyText(text(entry.prompt)).then(function (ok) {
          flash(button, ok ? t('copied') : t('copyFailed'), ok)
        })
      }),
    )
    actions.appendChild(
      actionButton(t('start'), ICONS.arrow, function (button) {
        startSession(text(entry.prompt), button)
      }),
    )

    var body = [head, h('p', { class: 'pg-when', text: text(entry.when) }), prompt, actions]
    body.push(h('p', { class: 'pg-outcome' }, [h('strong', { text: t('outcome') + '：' }), h('span', { text: text(entry.outcome) })]))
    if (entry.note) body.push(h('p', { class: 'pg-note', text: text(entry.note) }))
    if (entry.tools && entry.tools.length > 0) {
      var tools = h('div', { class: 'pg-tools' })
      entry.tools.forEach(function (name) {
        tools.appendChild(toolChip(name))
      })
      body.push(tools)
    }
    return h('article', { class: 'pg-card' }, body)
  }

  function renderCards() {
    el.cards.textContent = ''
    var entries = visibleEntries()
    if (entries.length === 0) {
      el.empty.hidden = false
      el.empty.textContent = t('empty')
      return
    }
    el.empty.hidden = true

    var categories = (doc.categories || []).slice().sort(function (a, b) {
      return (a.order || 0) - (b.order || 0)
    })
    categories.forEach(function (category) {
      var group = entries.filter(function (entry) {
        return entry.category === category.id
      })
      if (group.length === 0) return
      var section = h('section', { class: 'pg-group' }, [
        h('h2', null, [text(category.title)]),
        h('p', null, [text(category.summary)]),
      ])
      // Cards are siblings of the headings so the grid gaps stay uniform.
      el.cards.appendChild(section)
      group
        .slice()
        .sort(function (a, b) {
          return (a.order || 0) - (b.order || 0)
        })
        .forEach(function (entry) {
          el.cards.appendChild(card(entry))
        })
    })
  }

  function render() {
    if (!doc) return
    document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en'
    if (el.title) el.title.textContent = t('title')
    document.title = t('title') + ' · dsh-automation-suite'
    el.lede.textContent = t('lede')
    el.search.setAttribute('placeholder', t('search'))
    document.querySelectorAll('.pg-lang button').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-lang') === state.lang))
    })
    el.meta.textContent = t('meta')((doc.entries || []).length, doc.version)
    renderNotes()
    renderNav()
    renderCards()
  }

  // ------------------------------------------------------------- behaviours

  function copyText(value) {
    return new Promise(function (resolve) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(
          function () {
            resolve(true)
          },
          function () {
            resolve(fallbackCopy(value))
          },
        )
        return
      }
      resolve(fallbackCopy(value))
    })
  }

  function fallbackCopy(value) {
    var area = h('textarea', { readonly: '', 'aria-hidden': 'true' })
    area.value = value
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    var ok = false
    try {
      area.select()
      ok = document.execCommand('copy')
    } catch (error) {
      ok = false
    }
    area.remove()
    return ok
  }

  function startSession(prompt, button) {
    lastStartButton = button
    if (window.parent === window) {
      flash(button, t('startUnavailable'), false)
      return
    }
    flash(button, t('starting'), true)
    window.parent.postMessage({ type: 'prompt-guide:start', prompt: prompt }, window.location.origin)
  }

  function onShellMessage(event) {
    if (event.origin !== window.location.origin) return
    var message = event.data
    if (!message || typeof message !== 'object') return
    if (message.type === 'prompt-guide:scheme') {
      if (message.scheme === 'light' || message.scheme === 'dark') {
        document.documentElement.setAttribute('data-scheme', message.scheme)
      }
      return
    }
    if (message.type === 'prompt-guide:start-ok') {
      flash(lastStartButton, t('startOk'), true)
      return
    }
    if (message.type === 'prompt-guide:start-failed') {
      flash(lastStartButton, t('startFail'), false)
    }
  }

  function bind() {
    el.search.addEventListener('input', function () {
      state.query = el.search.value
      renderCards()
    })
    document.querySelectorAll('.pg-lang button').forEach(function (button) {
      button.addEventListener('click', function () {
        state.lang = button.getAttribute('data-lang') === 'en' ? 'en' : 'zh'
        try {
          localStorage.setItem(LANG_KEY, state.lang)
        } catch (error) {
          /* private mode */
        }
        render()
      })
    })
    document.addEventListener('keydown', function (event) {
      var typing = event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)
      if (event.key === '/' && !typing) {
        event.preventDefault()
        el.search.focus()
      } else if (event.key === 'Escape' && document.activeElement === el.search) {
        el.search.value = ''
        state.query = ''
        renderCards()
      }
    })
    window.addEventListener('message', onShellMessage)
  }

  function fail(error) {
    el.cards.textContent = ''
    var card = h('div', { class: 'pg-card' }, [
      h('h3', null, [t('loadFailed')]),
      h('p', { class: 'pg-outcome', text: String((error && error.message) || error) }),
    ])
    var retry = h('button', {
      type: 'button',
      class: 'pg-btn',
      text: t('retry'),
    })
    retry.addEventListener('click', load)
    card.appendChild(retry)
    el.cards.appendChild(card)
  }

  function load() {
    fetch('./api/guide', { headers: { accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      })
      .then(function (payload) {
        doc = payload
        render()
      })
      .catch(fail)
  }

  bind()
  render()
  load()
})()
