/**
 * GLOBAL SMS — Panel Branding token catalogue.
 *
 * Split out of branding.js because the catalogue is data, not logic.
 *
 * Every colour token belongs to one of TWELVE named categories and carries:
 *   k     storage key
 *   g     category name (shown as a heading in the panel)
 *   l     descriptive label
 *   w     a short "where it applies" explanation shown under the label
 *   hint  the value the app uses when nothing is set (the INHERITED value)
 *   scope 'shared' | 'light' | 'dark'
 *
 * A 'shared' token holds TWO independent values — one for the light set and
 * one for the dark set. Saving one set never writes to the other (Req 5D).
 * 'light' and 'dark' scoped tokens exist in a single set only and hold
 * theme-level values (accent / primary / secondary).
 *
 * CSS_MAP tells the runtime which CSS rule each token drives. Each entry is
 *   [ root, selectorSuffix, property ]
 * where `root` is one of:
 *   'L'     html body.ams-light.ams-panel
 *   'D'     html body.ams-dark.ams-panel
 *   'LOGIN' html body.ams-light:is(.ams-login,.ams-portal-login)
 *   'RAW'   the selector is written out in full (no root prefix)
 * A shared token is emitted under BOTH roots, once from the light value and
 * once from the dark value.
 */
'use strict';

const CATEGORIES = [
  'General Branding',
  'Login Page',
  'Header and Top Toolbar',
  'Sidebar',
  'Dashboard Cards',
  'Tables and Reports',
  'Forms and Inputs',
  'Buttons',
  'Modals and Popups',
  'Alerts and Status Indicators',
  'Light Theme',
  'Dark Theme',
];

const TOKENS = [
  /* ---------------------------------------------------------------- *
   * 1. General Branding                                              *
   * ---------------------------------------------------------------- */
  { k: 'general.bg',            g: 'General Branding', l: 'Application background',
    w: 'The page canvas behind every role panel, dashboard and report.', hint: '#f4f6fa' },
  { k: 'general.contentBg',     g: 'General Branding', l: 'Main content background',
    w: 'The area to the right of the sidebar where page content sits.', hint: '#f4f6fa' },
  { k: 'general.heading',       g: 'General Branding', l: 'Headings',
    w: 'Page titles and section headings (h1 - h4) across the panels.', hint: '#0f172a' },
  { k: 'general.text',          g: 'General Branding', l: 'Body text',
    w: 'Default paragraph and label text throughout the application.', hint: '#1e293b' },
  { k: 'general.textSecondary', g: 'General Branding', l: 'Secondary text',
    w: 'Supporting text such as sub-labels and table captions.', hint: '#475569' },
  { k: 'general.textMuted',     g: 'General Branding', l: 'Muted text',
    w: 'Hints, timestamps and other low-emphasis text.', hint: '#64748b' },
  { k: 'general.footerBg',      g: 'General Branding', l: 'Footer background',
    w: 'The footer strip at the bottom of the page, if the page has one.', hint: '#0c1730' },
  { k: 'general.footerText',    g: 'General Branding', l: 'Footer text',
    w: 'Text inside the footer, including the support and copyright lines.', hint: '#94a3b8' },

  /* ---------------------------------------------------------------- *
   * 2. Login Page                                                    *
   * ---------------------------------------------------------------- */
  { k: 'login.bg',            g: 'Login Page', l: 'Background',
    w: 'The full-page background of all five login screens.', hint: '#071f34' },
  { k: 'login.bg2',           g: 'Login Page', l: 'Secondary background',
    w: 'The animated particle / orb layer that sits over the background.', hint: '#0b2a44' },
  { k: 'login.particle',      g: 'Login Page', l: 'Animation and particles',
    w: 'The colour of the drifting orbs, trails and particles.', hint: '#38bdf8' },
  { k: 'login.cardBg',        g: 'Login Page', l: 'Card background',
    w: 'The panel holding the username, password and CAPTCHA fields.', hint: '#ffffff' },
  { k: 'login.cardBorder',    g: 'Login Page', l: 'Card border',
    w: 'The outline around the login card.', hint: '#e2e8f0' },
  { k: 'login.cardShadow',    g: 'Login Page', l: 'Card shadow',
    w: 'The drop shadow that lifts the card off the background.', hint: '#020a20' },
  { k: 'login.heading',       g: 'Login Page', l: 'Heading',
    w: 'The brand title shown above the form fields.', hint: '#0f172a' },
  { k: 'login.sub',           g: 'Login Page', l: 'Description text',
    w: 'The tagline or subtitle under the heading.', hint: '#475569' },
  { k: 'login.inputBg',       g: 'Login Page', l: 'Input background',
    w: 'The fill of the username, password and CAPTCHA boxes.', hint: '#ffffff' },
  { k: 'login.inputBorder',   g: 'Login Page', l: 'Input border',
    w: 'The outline around each login field.', hint: '#cbd5e1' },
  { k: 'login.inputText',     g: 'Login Page', l: 'Input text',
    w: 'The text typed into the login fields.', hint: '#0f172a' },
  { k: 'login.placeholder',   g: 'Login Page', l: 'Placeholder text',
    w: 'The greyed prompt shown while a field is empty.', hint: '#94a3b8' },
  { k: 'login.inputFocus',    g: 'Login Page', l: 'Input focus ring',
    w: 'The border and glow shown on the field currently being typed in.', hint: '#0b43be' },
  { k: 'login.btnBg',         g: 'Login Page', l: 'Sign-in button',
    w: 'The background of the button that submits the login form.', hint: '#0b43be' },
  { k: 'login.btnText',       g: 'Login Page', l: 'Sign-in button text',
    w: 'The label on the sign-in button.', hint: '#ffffff' },
  { k: 'login.btnHover',      g: 'Login Page', l: 'Sign-in button hover',
    w: 'The button background while the pointer is over it.', hint: '#0b43be' },
  { k: 'login.btnActive',     g: 'Login Page', l: 'Sign-in button active',
    w: 'The button background for the instant it is being clicked.', hint: '#0a357f' },
  { k: 'login.link',          g: 'Login Page', l: 'Links',
    w: 'Any hyperlink on the login page, such as password help.', hint: '#0b43be' },
  { k: 'login.error',         g: 'Login Page', l: 'Error message',
    w: 'Text shown when a sign-in attempt is rejected.', hint: '#dc2626' },
  { k: 'login.success',       g: 'Login Page', l: 'Success message',
    w: 'Text shown after a successful action on the login page.', hint: '#16a34a' },

  /* ---------------------------------------------------------------- *
   * 3. Header and Top Toolbar                                        *
   * ---------------------------------------------------------------- */
  { k: 'header.bg',   g: 'Header and Top Toolbar', l: 'Header background',
    w: 'The top bar holding the brand, clock, theme switch and user menu.', hint: '#ffffff' },
  { k: 'header.text', g: 'Header and Top Toolbar', l: 'Header text and icons',
    w: 'The clock, user name and icon colour inside the top bar.', hint: '#0f172a' },

  /* ---------------------------------------------------------------- *
   * 4. Sidebar                                                       *
   * ---------------------------------------------------------------- */
  { k: 'sidebar.bg',         g: 'Sidebar', l: 'Sidebar background',
    w: 'The left navigation column on Admin, Manager, Agent and Client.', hint: '#0c1730' },
  { k: 'sidebar.text',       g: 'Sidebar', l: 'Sidebar text and icons',
    w: 'The menu item labels and their icons.', hint: '#cbd5e1' },
  { k: 'sidebar.hoverBg',    g: 'Sidebar', l: 'Hover background',
    w: 'A menu item while the pointer is over it.', hint: '#16264a' },
  { k: 'sidebar.activeBg',   g: 'Sidebar', l: 'Active item background',
    w: 'The menu item for the page you are currently on.', hint: '#0b43be' },
  { k: 'sidebar.activeText', g: 'Sidebar', l: 'Active item text',
    w: 'The label of the page you are currently on.', hint: '#ffffff' },

  /* ---------------------------------------------------------------- *
   * 5. Dashboard Cards                                               *
   * ---------------------------------------------------------------- */
  { k: 'card.bg',     g: 'Dashboard Cards', l: 'Card background',
    w: 'Stat tiles, panels, table containers and toolbar strips.', hint: '#ffffff' },
  { k: 'card.border', g: 'Dashboard Cards', l: 'Card border',
    w: 'The outline around each card and panel.', hint: '#e3e8f0' },
  { k: 'card.shadow', g: 'Dashboard Cards', l: 'Card shadow',
    w: 'The soft shadow beneath each card.', hint: '#0f1b2d' },

  /* ---------------------------------------------------------------- *
   * 6. Tables and Reports                                            *
   * ---------------------------------------------------------------- */
  { k: 'table.headerBg',      g: 'Tables and Reports', l: 'Header background',
    w: 'The column heading row of every table and report.', hint: '#f8fafc' },
  { k: 'table.headerText',    g: 'Tables and Reports', l: 'Header text',
    w: 'The column names in a table heading row.', hint: '#475569' },
  { k: 'table.rowBg',         g: 'Tables and Reports', l: 'Row background',
    w: 'The normal background of a data row.', hint: '#ffffff' },
  { k: 'table.rowAltBg',      g: 'Tables and Reports', l: 'Alternate row background',
    w: 'Every second row, used for zebra striping in long reports.', hint: '#f8fafc' },
  { k: 'table.rowHoverBg',    g: 'Tables and Reports', l: 'Row hover background',
    w: 'A row while the pointer is over it.', hint: '#f3f6fb' },
  { k: 'table.rowSelectedBg', g: 'Tables and Reports', l: 'Selected row background',
    w: 'Rows ticked with the row checkbox, before any bulk action.', hint: '#eaf1ff' },
  { k: 'table.border',        g: 'Tables and Reports', l: 'Grid lines',
    w: 'The lines between cells and around the table.', hint: '#e3e8f0' },
  { k: 'table.text',          g: 'Tables and Reports', l: 'Cell text',
    w: 'The data shown inside table cells.', hint: '#1e293b' },

  /* ---------------------------------------------------------------- *
   * 7. Forms and Inputs                                              *
   * ---------------------------------------------------------------- */
  { k: 'form.label',       g: 'Forms and Inputs', l: 'Field label',
    w: 'The caption above each input in create and edit forms.', hint: '#334155' },
  { k: 'form.inputBg',     g: 'Forms and Inputs', l: 'Input background',
    w: 'The fill of text boxes, dropdowns and text areas.', hint: '#ffffff' },
  { k: 'form.inputBorder', g: 'Forms and Inputs', l: 'Input border',
    w: 'The outline around each field.', hint: '#cbd5e1' },
  { k: 'form.inputText',   g: 'Forms and Inputs', l: 'Input text',
    w: 'The value typed or selected in a field.', hint: '#0f172a' },
  { k: 'form.placeholder', g: 'Forms and Inputs', l: 'Placeholder text',
    w: 'The greyed prompt shown while a field is empty.', hint: '#94a3b8' },
  { k: 'form.focus',       g: 'Forms and Inputs', l: 'Focus border and glow',
    w: 'The highlight on the field currently being edited.', hint: '#0b43be' },
  { k: 'form.checkbox',    g: 'Forms and Inputs', l: 'Checkbox and radio accent',
    w: 'The tick colour of checkboxes and radio buttons.', hint: '#0b43be' },

  /* ---------------------------------------------------------------- *
   * 8. Buttons                                                       *
   * ---------------------------------------------------------------- */
  { k: 'btn.primaryBg',     g: 'Buttons', l: 'Primary background',
    w: 'The main action button, for example Save or Send.', hint: '#0b43be' },
  { k: 'btn.primaryText',   g: 'Buttons', l: 'Primary text',
    w: 'The label on the primary button.', hint: '#ffffff' },
  { k: 'btn.primaryHover',  g: 'Buttons', l: 'Primary hover',
    w: 'The primary button while the pointer is over it.', hint: '#0b43be' },
  { k: 'btn.secondaryBg',   g: 'Buttons', l: 'Secondary background',
    w: 'Softer actions such as Cancel, Back or Clear.', hint: '#e2e8f0' },
  { k: 'btn.secondaryText', g: 'Buttons', l: 'Secondary text',
    w: 'The label on a secondary or ghost button.', hint: '#1e293b' },
  { k: 'btn.successBg',     g: 'Buttons', l: 'Success background',
    w: 'Confirm and approve actions, such as Accept or Activate.', hint: '#0f9d6b' },
  { k: 'btn.successText',   g: 'Buttons', l: 'Success text',
    w: 'The label on a success button.', hint: '#ffffff' },
  { k: 'btn.warningBg',     g: 'Buttons', l: 'Warning background',
    w: 'Actions that need care, such as Suspend.', hint: '#c77d0a' },
  { k: 'btn.warningText',   g: 'Buttons', l: 'Warning text',
    w: 'The label on a warning button.', hint: '#ffffff' },
  { k: 'btn.dangerBg',      g: 'Buttons', l: 'Danger background',
    w: 'Destructive actions such as Delete or Reject.', hint: '#d6364a' },
  { k: 'btn.dangerText',    g: 'Buttons', l: 'Danger text',
    w: 'The label on a danger button.', hint: '#ffffff' },
  { k: 'btn.neutralBg',     g: 'Buttons', l: 'Neutral background',
    w: 'Pager controls at the bottom of tables and reports.', hint: '#64748b' },
  { k: 'btn.neutralText',   g: 'Buttons', l: 'Neutral text',
    w: 'The page numbers in the pager.', hint: '#ffffff' },

  /* ---------------------------------------------------------------- *
   * 9. Modals and Popups                                             *
   * ---------------------------------------------------------------- */
  { k: 'modal.bg',      g: 'Modals and Popups', l: 'Modal background',
    w: 'The surface of dialog boxes such as Create User or Confirm.', hint: '#ffffff' },
  { k: 'modal.text',    g: 'Modals and Popups', l: 'Modal text',
    w: 'Body text inside a dialog box.', hint: '#1e293b' },
  { k: 'modal.overlay', g: 'Modals and Popups', l: 'Overlay backdrop',
    w: 'The dimmed layer behind an open dialog.', hint: '#060c18' },

  /* ---------------------------------------------------------------- *
   * 10. Alerts and Status Indicators                                 *
   * ---------------------------------------------------------------- */
  { k: 'status.successBg',   g: 'Alerts and Status Indicators', l: 'Success badge',
    w: 'Badges such as Delivered, Active or Paid.', hint: '#e3f6ee' },
  { k: 'status.successText', g: 'Alerts and Status Indicators', l: 'Success badge text',
    w: 'The wording inside a success badge.', hint: '#0a7a54' },
  { k: 'status.warningBg',   g: 'Alerts and Status Indicators', l: 'Warning badge',
    w: 'Badges such as Pending, Queued or Low Balance.', hint: '#fdf1dc' },
  { k: 'status.warningText', g: 'Alerts and Status Indicators', l: 'Warning badge text',
    w: 'The wording inside a warning badge.', hint: '#9a5f05' },
  { k: 'status.dangerBg',    g: 'Alerts and Status Indicators', l: 'Danger badge',
    w: 'Badges such as Failed, Rejected or Suspended.', hint: '#fde8eb' },
  { k: 'status.dangerText',  g: 'Alerts and Status Indicators', l: 'Danger badge text',
    w: 'The wording inside a danger badge.', hint: '#b72a3c' },
  { k: 'status.infoBg',      g: 'Alerts and Status Indicators', l: 'Info badge',
    w: 'Neutral informational badges such as Draft or New.', hint: '#eaf1ff' },
  { k: 'status.infoText',    g: 'Alerts and Status Indicators', l: 'Info badge text',
    w: 'The wording inside an info badge.', hint: '#0b43be' },

  /* ---------------------------------------------------------------- *
   * 11. Light Theme / 12. Dark Theme                                  *
   * Theme-level values. Each set owns its own three, and saving one    *
   * set never writes to the other.                                    *
   * ---------------------------------------------------------------- */
  { k: 'theme.accent',    g: 'Light Theme', l: 'Accent colour', scope: 'light',
    w: 'Highlights, focus rings and small accent details while Light is active.', hint: '#0b43be' },
  { k: 'theme.primary',   g: 'Light Theme', l: 'Primary brand colour', scope: 'light',
    w: 'The main brand colour behind buttons and links while Light is active.', hint: '#0b43be' },
  { k: 'theme.secondary', g: 'Light Theme', l: 'Secondary brand colour', scope: 'light',
    w: 'Supporting brand colour used for gradients and charts while Light is active.', hint: '#38bdf8' },

  { k: 'theme.accent',    g: 'Dark Theme', l: 'Accent colour', scope: 'dark',
    w: 'Highlights, focus rings and small accent details while Dark is active.', hint: '#38bdf8' },
  { k: 'theme.primary',   g: 'Dark Theme', l: 'Primary brand colour', scope: 'dark',
    w: 'The main brand colour behind buttons and links while Dark is active.', hint: '#155eef' },
  { k: 'theme.secondary', g: 'Dark Theme', l: 'Secondary brand colour', scope: 'dark',
    w: 'Supporting brand colour used for gradients and charts while Dark is active.', hint: '#6f9cff' },
];

/* theme-scoped keys are stored per set, so qualify them by scope */
for (const t of TOKENS) if (!t.scope) t.scope = 'shared';

const CSS_MAP = {
  /* -- general -- */
  'general.bg':            [['L', '', 'background-color'], ['D', '', 'background-color']],
  'general.contentBg':     [['L', ' :is(.content,.main,.page)', 'background-color'], ['D', ' :is(.content,.main,.page)', 'background-color']],
  'general.heading':       [['L', ' :is(h1,h2,h3,h4)', 'color'], ['D', ' :is(h1,h2,h3,h4)', 'color']],
  'general.text':          [['L', '', 'color'], ['D', '', 'color']],
  'general.textSecondary': [['L', ' :is(.sub,.secondary,.cell-sub)', 'color'], ['D', ' :is(.sub,.secondary,.cell-sub)', 'color']],
  'general.textMuted':     [['L', ' :is(.muted,small,.hint)', 'color'], ['D', ' :is(.muted,small,.hint)', 'color']],
  'general.footerBg':      [['L', ' :is(footer,.footer)', 'background'], ['D', ' :is(footer,.footer)', 'background']],
  'general.footerText':    [['L', ' :is(footer,.footer)', 'color'], ['D', ' :is(footer,.footer)', 'color']],

  /* -- login (always rendered on the light root) -- */
  'login.bg':          [['LOGIN', '', 'background-color'], ['LOGIN', '', 'background']],
  'login.bg2':         [['RAW', 'html .ams-login-bg::before', 'background']],
  'login.particle':    [['RAW', 'html .ams-login-bg > *', 'background-color']],
  'login.cardBg':      [['LOGIN', ' :is(.shell,.card)', 'background']],
  'login.cardBorder':  [['LOGIN', ' :is(.shell,.card)', 'border-color']],
  'login.cardShadow':  [['LOGIN', ' :is(.shell,.card)', 'box-shadow']],
  'login.heading':     [['LOGIN', ' :is(h1,h2,h3)', 'color']],
  'login.sub':         [['LOGIN', ' :is(.sub,.muted,.eyebrow,small)', 'color']],
  'login.inputBg':     [['LOGIN', ' :is(input,select,textarea)', 'background-color']],
  'login.inputBorder': [['LOGIN', ' :is(input,select,textarea)', 'border-color']],
  'login.inputText':   [['LOGIN', ' :is(input,select,textarea)', 'color']],
  'login.placeholder': [['LOGIN', ' :is(input,select,textarea)::placeholder', 'color']],
  'login.inputFocus':  [['LOGIN', ' :is(input,select,textarea):focus', 'border-color'],
                        ['LOGIN', ' :is(input,select,textarea):focus', 'box-shadow']],
  'login.btnBg':       [['LOGIN', ' button:not([type=button])', 'background']],
  'login.btnText':     [['LOGIN', ' button:not([type=button])', 'color']],
  'login.btnHover':    [['LOGIN', ' button:not([type=button]):hover', 'background']],
  'login.btnActive':   [['LOGIN', ' button:not([type=button]):active', 'background']],
  'login.link':        [['LOGIN', ' a', 'color']],
  'login.error':       [['LOGIN', ' :is(.err,.msg.err,.error)', 'color']],
  'login.success':     [['LOGIN', ' :is(.ok,.msg.ok,.success)', 'color']],

  /* -- header -- */
  'header.bg':   [['L', ' :is(.topbar,.mgr-topbar,.top,.headerbar)', 'background'], ['D', ' :is(.topbar,.mgr-topbar,.top,.headerbar)', 'background']],
  'header.text': [['L', ' :is(.topbar,.mgr-topbar,.top,.headerbar)', 'color'], ['D', ' :is(.topbar,.mgr-topbar,.top,.headerbar)', 'color']],

  /* -- sidebar -- */
  'sidebar.bg':         [['L', ' :is(.sidebar,.rail,.side,.appbar)', 'background'], ['D', ' :is(.sidebar,.rail,.side,.appbar)', 'background']],
  'sidebar.text':       [['L', ' :is(.nav-item,.ritem,.navtab,.side .item,.sidebar .tab)', 'color'], ['D', ' :is(.nav-item,.ritem,.navtab,.side .item,.sidebar .tab)', 'color']],
  'sidebar.hoverBg':    [['L', ' :is(.nav-item,.ritem,.navtab,.side .item,.sidebar .tab):hover', 'background-color'], ['D', ' :is(.nav-item,.ritem,.navtab,.side .item,.sidebar .tab):hover', 'background-color']],
  'sidebar.activeBg':   [['L', ' :is(.nav-item,.ritem,.navtab,.side .item,.sidebar .tab).active', 'background'], ['D', ' :is(.nav-item,.ritem,.navtab,.side .item,.sidebar .tab).active', 'background']],
  'sidebar.activeText': [['L', ' :is(.nav-item,.ritem,.navtab,.side .item,.sidebar .tab).active', 'color'], ['D', ' :is(.nav-item,.ritem,.navtab,.side .item,.sidebar .tab).active', 'color']],

  /* -- cards -- */
  'card.bg':     [['L', ' :is(.card,.panel,.table-wrap,.toolbar,.box)', 'background'], ['D', ' :is(.card,.panel,.table-wrap,.toolbar,.box)', 'background']],
  'card.border': [['L', ' :is(.card,.panel,.table-wrap,.toolbar,.box)', 'border-color'], ['D', ' :is(.card,.panel,.table-wrap,.toolbar,.box)', 'border-color']],
  'card.shadow': [['L', ' :is(.card,.panel,.table-wrap,.toolbar,.box)', 'box-shadow'], ['D', ' :is(.card,.panel,.table-wrap,.toolbar,.box)', 'box-shadow']],

  /* -- tables -- */
  'table.headerBg':      [['L', ' :is(thead,thead th,th)', 'background'], ['D', ' :is(thead,thead th,th)', 'background']],
  'table.headerText':    [['L', ' :is(thead,thead th,th)', 'color'], ['D', ' :is(thead,thead th,th)', 'color']],
  'table.rowBg':         [['L', ' :is(tbody tr,tbody td,td)', 'background-color'], ['D', ' :is(tbody tr,tbody td,td)', 'background-color']],
  'table.rowAltBg':      [['L', ' tbody tr:nth-child(even) td', 'background-color'], ['D', ' tbody tr:nth-child(even) td', 'background-color']],
  'table.rowHoverBg':    [['L', ' tbody tr:hover td', 'background-color'], ['D', ' tbody tr:hover td', 'background-color']],
  'table.rowSelectedBg': [['L', ' tbody tr.selected td', 'background-color'], ['D', ' tbody tr.selected td', 'background-color']],
  'table.border':        [['L', ' :is(th,td)', 'border-color'], ['D', ' :is(th,td)', 'border-color']],
  'table.text':          [['L', ' :is(tbody td,td)', 'color'], ['D', ' :is(tbody td,td)', 'color']],

  /* -- forms -- */
  'form.label':       [['L', ' label', 'color'], ['D', ' label', 'color']],
  'form.inputBg':     [['L', ' :is(input,select,textarea,.sd-trigger)', 'background-color'], ['D', ' :is(input,select,textarea,.sd-trigger)', 'background-color']],
  'form.inputBorder': [['L', ' :is(input,select,textarea,.sd-trigger)', 'border-color'], ['D', ' :is(input,select,textarea,.sd-trigger)', 'border-color']],
  'form.inputText':   [['L', ' :is(input,select,textarea,.sd-trigger)', 'color'], ['D', ' :is(input,select,textarea,.sd-trigger)', 'color']],
  'form.placeholder': [['L', ' :is(input,select,textarea)::placeholder', 'color'], ['D', ' :is(input,select,textarea)::placeholder', 'color']],
  'form.focus':       [['L', ' :is(input,select,textarea):focus', 'border-color'], ['D', ' :is(input,select,textarea):focus', 'border-color']],
  'form.checkbox':    [['L', ' :is(input[type=checkbox],input[type=radio])', 'accent-color'], ['D', ' :is(input[type=checkbox],input[type=radio])', 'accent-color']],

  /* -- buttons -- */
  'btn.primaryBg':     [['L', ' :is(.btn,.ams-btn,.ms-btn.primary)', 'background'], ['D', ' :is(.btn,.ams-btn,.ms-btn.primary)', 'background']],
  'btn.primaryText':   [['L', ' :is(.btn,.ams-btn,.ms-btn.primary)', 'color'], ['D', ' :is(.btn,.ams-btn,.ms-btn.primary)', 'color']],
  'btn.primaryHover':  [['L', ' :is(.btn,.ams-btn,.ms-btn.primary):hover', 'background'], ['D', ' :is(.btn,.ams-btn,.ms-btn.primary):hover', 'background']],
  'btn.secondaryBg':   [['L', ' :is(.btn-ghost,.btn.secondary,.ams-btn.secondary)', 'background'], ['D', ' :is(.btn-ghost,.btn.secondary,.ams-btn.secondary)', 'background']],
  'btn.secondaryText': [['L', ' :is(.btn-ghost,.btn.secondary,.ams-btn.secondary)', 'color'], ['D', ' :is(.btn-ghost,.btn.secondary,.ams-btn.secondary)', 'color']],
  'btn.successBg':     [['L', ' :is(.btn-green,.btn.green,.ams-green)', 'background'], ['D', ' :is(.btn-green,.btn.green,.ams-green)', 'background']],
  'btn.successText':   [['L', ' :is(.btn-green,.btn.green,.ams-green)', 'color'], ['D', ' :is(.btn-green,.btn.green,.ams-green)', 'color']],
  'btn.warningBg':     [['L', ' :is(.btn-amber,.btn-orange,.ams-amber)', 'background'], ['D', ' :is(.btn-amber,.btn-orange,.ams-amber)', 'background']],
  'btn.warningText':   [['L', ' :is(.btn-amber,.btn-orange,.ams-amber)', 'color'], ['D', ' :is(.btn-amber,.btn-orange,.ams-amber)', 'color']],
  'btn.dangerBg':      [['L', ' :is(.btn-red,.btn.red,.ams-red,.ams-btn.danger)', 'background'], ['D', ' :is(.btn-red,.btn.red,.ams-red,.ams-btn.danger)', 'background']],
  'btn.dangerText':    [['L', ' :is(.btn-red,.btn.red,.ams-red,.ams-btn.danger)', 'color'], ['D', ' :is(.btn-red,.btn.red,.ams-red,.ams-btn.danger)', 'color']],
  'btn.neutralBg':     [['L', ' .pagination button', 'background'], ['D', ' .pagination button', 'background']],
  'btn.neutralText':   [['L', ' .pagination button', 'color'], ['D', ' .pagination button', 'color']],

  /* -- modals -- */
  'modal.bg':      [['L', ' :is(.modal-box,.ms-modal,.modal)', 'background'], ['D', ' :is(.modal-box,.ms-modal,.modal)', 'background']],
  'modal.text':    [['L', ' :is(.modal-box,.ms-modal,.modal)', 'color'], ['D', ' :is(.modal-box,.ms-modal,.modal)', 'color']],
  'modal.overlay': [['L', ' :is(.overlay,.sb-overlay,.mgr-mobile-overlay)', 'background'], ['D', ' :is(.overlay,.sb-overlay,.mgr-mobile-overlay)', 'background']],

  /* -- status -- */
  'status.successBg':   [['L', ' :is(.badge,.tag,.status).is-ok', 'background'], ['D', ' :is(.badge,.tag,.status).is-ok', 'background']],
  'status.successText': [['L', ' :is(.badge,.tag,.status).is-ok', 'color'], ['D', ' :is(.badge,.tag,.status).is-ok', 'color']],
  'status.warningBg':   [['L', ' :is(.badge,.tag,.status).is-warn', 'background'], ['D', ' :is(.badge,.tag,.status).is-warn', 'background']],
  'status.warningText': [['L', ' :is(.badge,.tag,.status).is-warn', 'color'], ['D', ' :is(.badge,.tag,.status).is-warn', 'color']],
  'status.dangerBg':    [['L', ' :is(.badge,.tag,.status).is-bad', 'background'], ['D', ' :is(.badge,.tag,.status).is-bad', 'background']],
  'status.dangerText':  [['L', ' :is(.badge,.tag,.status).is-bad', 'color'], ['D', ' :is(.badge,.tag,.status).is-bad', 'color']],
  'status.infoBg':      [['L', ' :is(.badge,.tag,.status).is-info', 'background'], ['D', ' :is(.badge,.tag,.status).is-info', 'background']],
  'status.infoText':    [['L', ' :is(.badge,.tag,.status).is-info', 'color'], ['D', ' :is(.badge,.tag,.status).is-info', 'color']],

  /* -- theme level: emitted as CSS custom properties on the theme root -- */
  'theme.accent':    [['L', '', '--brand-accent'], ['D', '', '--brand-accent']],
  'theme.primary':   [['L', '', '--brand-primary'], ['D', '', '--brand-primary']],
  'theme.secondary': [['L', '', '--brand-secondary'], ['D', '', '--brand-secondary']],
};

/* storage keys, per scope */
const SHARED_KEYS = TOKENS.filter(t => t.scope === 'shared').map(t => t.k);
const LIGHT_KEYS  = TOKENS.filter(t => t.scope !== 'dark').map(t => t.k);
const DARK_KEYS   = TOKENS.filter(t => t.scope !== 'light').map(t => t.k);

/**
 * Translate a settings object saved under the OLD flat schema into the
 * per-theme schema. Old `dark.*` tokens fold into the dark value of the
 * matching shared token; everything else becomes the light value.
 */
const LEGACY_DARK_TO_SHARED = {
  'dark.bg': 'general.bg',
  'dark.headerBg': 'header.bg',
  'dark.headerText': 'header.text',
  'dark.sidebarBg': 'sidebar.bg',
  'dark.sidebarText': 'sidebar.text',
  'dark.sidebarActiveBg': 'sidebar.activeBg',
  'dark.cardBg': 'card.bg',
  'dark.cardBorder': 'card.border',
  'dark.text': 'general.text',
  'dark.textMuted': 'general.textMuted',
  'dark.inputBg': 'form.inputBg',
  'dark.inputBorder': 'form.inputBorder',
  'dark.tableHeaderBg': 'table.headerBg',
  'dark.tableBorder': 'table.border',
};
const LEGACY_RENAME = {
  'panel.bg': 'general.bg',
  'panel.contentBg': 'general.contentBg',
  'panel.heading': 'general.heading',
  'panel.text': 'general.text',
  'panel.textSecondary': 'general.textSecondary',
  'panel.textMuted': 'general.textMuted',
  'panel.headerBg': 'header.bg',
  'panel.headerText': 'header.text',
  'panel.sidebarBg': 'sidebar.bg',
  'panel.sidebarText': 'sidebar.text',
  'panel.sidebarHoverBg': 'sidebar.hoverBg',
  'panel.sidebarActiveBg': 'sidebar.activeBg',
  'panel.sidebarActiveText': 'sidebar.activeText',
  'panel.cardBg': 'card.bg',
  'panel.cardBorder': 'card.border',
  'panel.cardShadow': 'card.shadow',
  'footer.bg': 'general.footerBg',
  'footer.text': 'general.footerText',
};

module.exports = {
  CATEGORIES, TOKENS, CSS_MAP,
  SHARED_KEYS, LIGHT_KEYS, DARK_KEYS,
  LEGACY_DARK_TO_SHARED, LEGACY_RENAME,
};
