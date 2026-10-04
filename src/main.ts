import { invoke, isTauri } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

type Subject = { Id: string; Name: string; QuickFields: string[] };
type HomeworkTag = { Id: string; Name: string; Color: string };
type HomeworkItem = {
  Id: string;
  SubjectId: string;
  ContentHtml: string;
  DueAt: string;
  CreatedAt: string;
  UpdatedAt: string;
  Tags?: string[];
};
type Settings = {
  Pages: {
    Basic: {
      alwaysOnBottom: boolean;
      windowTitle: string;
      zoom: number;
      contentScale: number;
      quickExportPath: string;
    };
    Subjects: { items: Subject[] };
    Tags: { items: HomeworkTag[] };
  };
};
type DataFile = "Settings.json" | "Homework.json";

const SETTINGS_KEY = "homework-attention-settings";
const HOMEWORK_KEY = "homework-attention-homework";
const DEFAULT_TAG_COLOR = "#2196F3";
const DEFAULT_TAGS: HomeworkTag[] = [
  { Id: "built-in-not-submit", Name: "不交", Color: DEFAULT_TAG_COLOR },
  { Id: "built-in-noon-homework", Name: "中午作业", Color: DEFAULT_TAG_COLOR },
];
const DEFAULT_SUBJECT_NAMES = [
  "语文",
  "数学",
  "英语",
  "物理",
  "化学",
  "政治",
  "历史",
  "地理",
  "生物",
  "其他",
];
const defaultSettings: Settings = {
  Pages: {
    Basic: {
      alwaysOnBottom: true,
      windowTitle: "作业",
      zoom: 100,
      contentScale: 110,
      quickExportPath: "",
    },
    Subjects: {
      items: DEFAULT_SUBJECT_NAMES.map((Name) => ({
        Id: crypto.randomUUID(),
        Name,
        QuickFields: [],
      })),
    },
    Tags: { items: structuredClone(DEFAULT_TAGS) },
  },
};

let settings = defaultSettings;
let homework: Record<string, HomeworkItem> = {};
let locked = true;
let menuOpen = false;
let settingsPage: "Basic" | "Subjects" | "Tags" = "Basic";
let editingSubjectId: string | null = null;
let editingRecords: HomeworkItem[] = [];
let editingExpiredOnly = false;
let viewingExpired = false;
let subjectPickerOpen = false;
let undoSnapshot: Record<string, HomeworkItem> | null = null;
let toastTimeout = 0;
const root = document.querySelector<HTMLElement>("#app");
const search = new URLSearchParams(window.location.search);
const viewMode = search.get("view");

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

function todayPlusOne(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localDateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isHomeworkExpired(item: HomeworkItem): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(item.DueAt) && item.DueAt <= localDateKey();
}

function removeExpiredHomeworkPastRetention(): boolean {
  const retentionLimit = new Date();
  retentionLimit.setDate(retentionLimit.getDate() - 1);
  const oldestRetainedDate = localDateKey(retentionLimit);
  const retainedEntries = Object.entries(homework).filter(([, item]) => (
    !/^\d{4}-\d{2}-\d{2}$/.test(item.DueAt) || item.DueAt >= oldestRetainedDate
  ));
  if (retainedEntries.length === Object.keys(homework).length) return false;
  homework = Object.fromEntries(retainedEntries);
  return true;
}

function expiredHomeworkCount(): number {
  return Object.values(homework).filter(isHomeworkExpired).length;
}

function hasActiveHomework(subjectId: string): boolean {
  return Object.values(homework).some((item) => item.SubjectId === subjectId && !isHomeworkExpired(item));
}

function normalizeSettings(input: Partial<Settings> | null): Settings {
  const basic = input?.Pages?.Basic;
  const subjects = input?.Pages?.Subjects?.items;
  const tags = input?.Pages?.Tags?.items;
  const zoom = Number(basic?.zoom ?? 100);
  const contentScale = Number(basic?.contentScale ?? 110);
  return {
    Pages: {
      Basic: {
        alwaysOnBottom: true,
        windowTitle: basic?.windowTitle || "作业",
        zoom: Number.isFinite(zoom) ? Math.min(150, Math.max(70, zoom)) : 100,
        contentScale: Number.isFinite(contentScale) ? Math.min(150, Math.max(80, contentScale)) : 110,
        quickExportPath: basic?.quickExportPath ?? "",
      },
      Subjects: {
        items: Array.isArray(subjects)
          ? subjects
            .filter((item) => item.Id && item.Name)
            .map((item) => ({
              Id: item.Id,
              Name: item.Name,
              QuickFields: Array.isArray(item.QuickFields)
                ? [...new Set(item.QuickFields.filter((field) => typeof field === "string").map((field) => field.trim()).filter(Boolean))]
                : [],
            }))
          : defaultSettings.Pages.Subjects.items,
      },
      Tags: {
        items: Array.isArray(tags)
          ? tags
            .filter((tag) => tag.Id && tag.Name)
            .map((tag) => ({
              Id: tag.Id,
              Name: tag.Name.trim(),
              Color: /^#[0-9a-f]{6}$/i.test(tag.Color) ? tag.Color : DEFAULT_TAG_COLOR,
            }))
          : structuredClone(DEFAULT_TAGS),
      },
    },
  };
}

async function readFile<T>(name: DataFile, browserKey: string): Promise<T | null> {
  if (isTauri()) {
    const content = await invoke<string | null>("read_data_file", { name });
    return content ? (JSON.parse(content) as T) : null;
  }
  const content = localStorage.getItem(browserKey);
  return content ? (JSON.parse(content) as T) : null;
}

async function writeFile(name: DataFile, browserKey: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  if (isTauri()) {
    await invoke("write_data_file", { name, content });
  } else {
    localStorage.setItem(browserKey, content);
  }
}

async function saveSettings(): Promise<void> {
  await writeFile("Settings.json", SETTINGS_KEY, settings);
  await notifyDataChanged("settings-changed");
}

async function saveHomework(): Promise<void> {
  await writeFile("Homework.json", HOMEWORK_KEY, homework);
  await notifyDataChanged("homework-changed");
}

async function notifyDataChanged(event: "settings-changed" | "homework-changed"): Promise<void> {
  if (isTauri()) await emit(event);
}

async function openPopup(view: "editor" | "settings", subjectId?: string, expiredOnly = false): Promise<void> {
  if (isTauri()) {
    await invoke("open_popup_window", {
      view,
      subjectId: subjectId ?? null,
      expiredOnly,
    });
  }
}

async function closeCurrentWindow(): Promise<void> {
  if (isTauri()) await getCurrentWindow().close();
}

function showToast(message: string): void {
  const toast = document.querySelector<HTMLElement>("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove("visible"), 2600);
}

function icon(name: string): string {
  const paths: Record<string, string> = {
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    add: '<path d="M12 5v14M5 12h14"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    unlock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7-2"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/>',
    quick: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 1.1 1.9-2 2-1.9-1.1a7 7 0 0 1-2 .8L14 21h-4l-.6-2.4a7 7 0 0 1-2-.8L5.5 19l-2-2L4.6 15a7 7 0 0 1-.8-2L1.5 12v-1l2.3-.6a7 7 0 0 1 .8-2L3.5 6.5l2-2L7.4 5.6a7 7 0 0 1 2-.8L10 2.5h4l.6 2.3a7 7 0 0 1 2 .8l1.9-1.1 2 2L19.4 8.4a7 7 0 0 1 .8 2l2.3.6v1l-2.3.6a7 7 0 0 1-.8 2Z"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6"/>',
    edit: '<path d="m15 5 4 4M4 20l4-.8L19 8a2.8 2.8 0 0 0-4-4L4 15z"/>',
    close: '<path d="m18 6-12 12M6 6l12 12"/>',
    bold: '<path d="M7 5h6a4 4 0 0 1 0 8H7zm0 8h7a4 4 0 0 1 0 8H7z"/>',
    italic: '<path d="M14 4h6M4 20h6M15 4 9 20"/>',
    underline: '<path d="M6 4v7a6 6 0 0 0 12 0V4M4 21h16"/>',
    palette: '<circle cx="12" cy="12" r="10"/><path d="M8 14a2 2 0 1 0 0 4h1v-4zm8-7h.01M7 9h.01M11 5h.01"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    pin: '<path d="m16 3 5 5-4 1-4 4 1 5-2 2-4-6-5-1 2-2 5 1 4-4z"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] ?? ""}</svg>`;
}

function renderBoard(): void {
  if (!root) return;
  const basic = settings.Pages.Basic;
  const subjects = settings.Pages.Subjects.items;
  const subjectsWithHomework = subjects
    .map((subject) => ({
      subject,
      items: Object.values(homework).filter((item) => (
        item.SubjectId === subject.Id && isHomeworkExpired(item) === viewingExpired
      )),
    }))
    .filter(({ items }) => items.length > 0);
  const groupsMarkup = subjectsWithHomework.length
    ? `<div class="subject-card-grid">${subjectsWithHomework.map(({ subject, items }) => {
        return `
          <button class="subject-card" data-subject-card="${subject.Id}" ${locked ? "" : "tabindex=-1"}>
            <span class="subject-card-heading"><strong>${htmlEscape(subject.Name)}</strong><span class="subject-card-count">${items.length} 条作业</span></span>
            <span class="subject-card-preview">${items.map((item) => `<span class="subject-preview-line"><span class="subject-preview-content">${sanitizeRichHtml(item.ContentHtml)}</span>${renderSelectedTagBadges(item.Tags ?? [])}</span>`).join("")}</span>
            <span class="subject-card-due">过期时间 · ${htmlEscape(items[0].DueAt)}</span>
            <span class="subject-card-open">${icon("chevron")}</span>
          </button>`;
      }).join("")}</div>`
    : `<div class="empty-board"><span class="empty-icon">${icon("pin")}</span><strong>${viewingExpired ? "没有过期作业" : "还没有作业"}</strong><span>${viewingExpired ? "过期作业会在这里保留一天。" : "点击底部“布置”给科目添加作业。"}</span></div>`;

  root.innerHTML = `
    <main class="app-shell ${locked ? "is-locked" : "is-unlocked"}" style="zoom:${basic.zoom / 100};--content-scale:${basic.contentScale / 100}">
      <header class="titlebar">
        <div class="app-title" data-drag-handle>${htmlEscape(basic.windowTitle)}</div>
        <div class="titlebar-actions">
          <button class="icon-button ${menuOpen ? "active" : ""}" data-action="menu" aria-label="更多选项" title="更多选项">${icon("menu")}</button>
          <button class="icon-button" data-action="undo" aria-label="撤销" title="撤销" ${undoSnapshot && locked ? "" : "disabled"}>${icon("undo")}</button>
          <button class="icon-button ${!locked ? "active" : ""}" data-action="lock" aria-label="${locked ? "解锁窗口" : "锁定窗口"}" title="${locked ? "点击解锁并移动窗口" : "点击锁定窗口"}">
            <span class="lock-track"><span class="lock-thumb">${icon(locked ? "lock" : "unlock")}</span></span>
          </button>
          <span class="toolbar-divider"></span>
          <button class="icon-button" data-action="export" aria-label="导出图片" title="导出图片">${icon("image")}</button>
          <button class="icon-button" data-action="quick-export" aria-label="快捷导出图片" title="快捷导出图片">${icon("quick")}</button>
          <button class="icon-button minimize-button" data-action="minimize" aria-label="隐藏到系统托盘" title="隐藏到系统托盘"><span></span></button>
        </div>
        ${menuOpen ? renderMenu() : ""}
      </header>
      <div class="board-area">
        <div class="board">
          ${viewingExpired ? `<h2 class="board-view-heading">过期作业</h2>` : ""}
          ${groupsMarkup}
        </div>
        ${!locked ? `<div class="unlock-guide">
          <div class="unlock-guide-card">
            <div class="guide-window-illustration"><div class="guide-window-frame"><span></span></div><i></i><b></b></div>
            <p>窗口已解锁</p>
            <span>拖动标题栏移动窗口，拖动边缘调整大小。</span>
            <small>作业内容编辑已暂停，点击右上角锁定按钮继续编辑。</small>
          </div>
        </div>` : ""}
        <footer class="board-footer">
          ${locked ? `<div class="board-footer-actions"><div class="content-size-controls" aria-label="作业文字大小"><button data-action="content-smaller" aria-label="缩小作业文字" title="缩小作业文字">A−</button><button data-action="content-larger" aria-label="放大作业文字" title="放大作业文字">A+</button></div>${viewingExpired
            ? `<button class="add-homework expired-homework-toggle" data-action="toggle-expired">${icon("chevron")}<span>返回作业</span></button>`
            : `<button class="expired-homework-toggle" data-action="toggle-expired">查看过期的作业${expiredHomeworkCount() ? `（${expiredHomeworkCount()}）` : ""}</button><button class="add-homework" data-action="add">${icon("add")}<span>布置</span></button>`}</div>` : `<span class="move-hint">${icon("unlock")}窗口已解锁，拖动标题栏移动 · 内容编辑已暂停</span>`}
        </footer>
      </div>
      <div id="toast" class="toast" role="status" aria-live="polite"></div>
      ${renderEditor()}
      ${renderSubjectPicker()}
      ${renderSubjectDialog()}
    </main>`;
  attachBoardEvents();
  applyWindowSettings().catch((error: unknown) => showToast(`窗口设置失败：${String(error)}`));
}

function renderMenu(): string {
  return `
    <div class="menu-panel" role="menu">
      <div class="menu-heading">${icon("settings")}<span>更多选项</span></div>
      <div class="menu-setting-row"><span>界面缩放</span><span class="menu-stepper"><button data-action="zoom-out" aria-label="缩小">−</button><span>${settings.Pages.Basic.zoom}%</span><button data-action="zoom-in" aria-label="放大">＋</button></span></div>
      <div class="menu-separator"></div>
      <button class="menu-item" data-action="clear" ${Object.keys(homework).length === 0 || !locked ? "disabled" : ""}>${icon("trash")}<span>一键清除作业</span></button>
      <button class="menu-item" data-action="settings" ${!locked ? "disabled" : ""}>${icon("settings")}<span>设置</span></button>
      <button class="menu-item" data-action="close">${icon("close")}<span>关闭并保存应用</span></button>
    </div>`;
}

function renderSubjectPicker(): string {
  if (!subjectPickerOpen) return "";
  const availableSubjects = settings.Pages.Subjects.items.filter(
    (subject) => !hasActiveHomework(subject.Id),
  );
  return `
    <div class="modal-backdrop subject-picker-backdrop" data-modal-backdrop="subject-picker">
      <section class="subject-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="subject-picker-title">
        <header class="dialog-header"><div><span class="dialog-kicker">NEW HOMEWORK</span><h2 id="subject-picker-title">选择要布置作业的科目</h2></div><button class="icon-button dialog-close" data-action="cancel-subject-picker" aria-label="关闭">${icon("close")}</button></header>
        ${availableSubjects.length
          ? `<div class="subject-picker-list">${availableSubjects.map((subject) => `<button class="subject-picker-option" data-action="pick-subject" data-id="${subject.Id}"><span class="subject-color-dot"></span><span>${htmlEscape(subject.Name)}</span>${icon("chevron")}</button>`).join("")}</div>`
          : `<div class="subject-picker-empty">${settings.Pages.Subjects.items.length ? "所有科目都已有作业，点击科目卡片即可编辑。" : "还没有科目，请先在设置中添加科目。"}</div>`}
        <footer class="dialog-footer"><button class="text-button" data-action="cancel-subject-picker">取消</button></footer>
      </section>
    </div>`;
}

function renderEditor(standalone = false): string {
  if (!editingSubjectId) return "";
  const earliestDueDate = todayPlusOne();
  const recordDueDate = editingRecords[0]?.DueAt;
  const selectedDate = recordDueDate && recordDueDate >= earliestDueDate
    ? recordDueDate
    : earliestDueDate;
  const subject = settings.Pages.Subjects.items.find((item) => item.Id === editingSubjectId);
  const rows = editingRecords.length
    ? editingRecords.map((record) => renderHomeworkLine(record.ContentHtml, record.Tags ?? [])).join("")
    : renderHomeworkLine("", []);
  return `
    ${standalone ? `<main class="popup-editor-shell">` : `<div class="modal-backdrop" data-modal-backdrop="editor">`}
      <section class="editor-dialog" role="dialog" aria-modal="true" aria-labelledby="editor-title">
        <header class="dialog-header"><div><span class="dialog-kicker">HOMEWORK</span><h2 id="editor-title">${editingRecords.length ? "编辑作业" : "布置作业"}</h2></div>${standalone ? "" : `<button class="icon-button dialog-close" data-action="cancel-editor" aria-label="关闭">${icon("close")}</button>`}</header>
        <div class="editor-fields">
          <label class="editor-field"><span class="field-label">科目</span><select class="select-field" id="homework-subject" ${editingRecords.length ? "disabled" : ""}>${settings.Pages.Subjects.items
            .filter((item) => editingRecords.length > 0
              || item.Id === editingSubjectId
              || !hasActiveHomework(item.Id))
            .map((item) => `<option value="${item.Id}" ${item.Id === editingSubjectId ? "selected" : ""}>${htmlEscape(item.Name)}</option>`)
            .join("")}</select></label>
          <label class="editor-field due-editor-field"><span class="field-label">过期时间</span><input class="date-field" id="homework-due" type="date" min="${earliestDueDate}" value="${selectedDate}"></label>
          <p class="field-caption">默认第二天；本学科作业共用一个过期时间。过期时间为交作业的时间。</p>
        </div>
        <div class="editor-layout">
          <div class="editor-main">
            <div class="format-toolbar" role="toolbar" aria-label="文本格式">
              <button class="format-button" data-format="bold" aria-label="加粗" title="加粗">${icon("bold")}</button>
              <button class="format-button" data-format="italic" aria-label="斜体" title="斜体">${icon("italic")}</button>
              <button class="format-button" data-format="underline" aria-label="下划线" title="下划线">${icon("underline")}</button>
              <div class="format-color-group">
                <label class="format-color" title="字体颜色">${icon("palette")}<input type="color" data-color-picker value="#000000" aria-label="自定义字体颜色"></label>
                <div class="quick-colors" aria-label="快捷字体颜色">
                  <button class="quick-color" data-color="#000000" aria-label="黑色" title="黑色" style="--swatch-color:#000000"></button>
                  <button class="quick-color" data-color="#FFFFFF" aria-label="白色" title="白色" style="--swatch-color:#FFFFFF"></button>
                  <button class="quick-color" data-color="#EB3324" aria-label="红色" title="红色" style="--swatch-color:#EB3324"></button>
                  <button class="quick-color" data-color="#0000FF" aria-label="蓝色" title="蓝色" style="--swatch-color:#0000FF"></button>
                  <button class="quick-color" data-color="#75F94D" aria-label="绿色" title="绿色" style="--swatch-color:#75F94D"></button>
                </div>
              </div>
              <span class="toolbar-spacer"></span><span class="format-hint">每行一条作业</span>
            </div>
            <ul class="rich-editor" id="rich-editor" role="list" aria-label="作业内容">${rows}</ul>
            ${(subject?.QuickFields.length || settings.Pages.Tags.items.length) ? `<div class="editor-quick-fields">
              ${subject?.QuickFields.length ? `<div class="editor-shortcut-group" aria-label="科目快捷文本">${subject.QuickFields.map((field) => `<button class="subject-quick-field" data-quick-field="${htmlEscape(field)}">${htmlEscape(field)}</button>`).join("")}</div>` : ""}
              ${settings.Pages.Tags.items.length ? `<div class="editor-shortcut-group editor-tag-controls" aria-label="作业标签">${settings.Pages.Tags.items.map((tag) => {
                const color = /^#[0-9a-f]{6}$/i.test(tag.Color) ? tag.Color : DEFAULT_TAG_COLOR;
                return `<button class="homework-tag" data-homework-tag="${tag.Id}" aria-pressed="false" style="--tag-color:${color};--tag-text-color:${getTagTextColor(color)}">${htmlEscape(tag.Name)}</button>`;
              }).join("")}</div>` : ""}
            </div>` : ""}
          </div>
          <aside class="editor-keypad" aria-label="输入键盘">
            ${["1", "2", "3", "4", "5", "6", "7", "8", "9", "-", "0"].map((key) => `<button class="keypad-key" data-keypad="${key}">${key}</button>`).join("")}
            <button class="keypad-key keypad-backspace" data-keypad="backspace" aria-label="退格">←</button>
            <button class="keypad-key keypad-wide" data-keypad="space">空格</button>
            <button class="keypad-key keypad-wide" data-keypad="enter">换行</button>
            <div class="keypad-quick-fields" aria-label="常用快捷文本">
              ${["课", "例", "变", "T", "P"].map((field) => `<button class="subject-quick-field" data-quick-field="${field}">${field}</button>`).join("")}
            </div>
          </aside>
        </div>
        <footer class="dialog-footer">
          <button class="text-button" data-action="cancel-editor">取消</button>
          <span class="dialog-footer-spacer"></span>
          ${editingRecords.length ? `<button class="text-button delete-homework-button" data-action="delete-editor">${icon("trash")}<span>删除</span></button>` : ""}
          <button class="primary-button" data-action="save-editor">保存作业</button>
        </footer>
      </section>
      ${standalone ? `<div id="toast" class="toast" role="status" aria-live="polite"></div>` : ""}
    ${standalone ? "</main>" : "</div>"}`;
}

function renderHomeworkLine(contentHtml: string, selectedTagIds: string[]): string {
  const content = sanitizeRichHtml(contentHtml) || "<br>";
  return `<li class="homework-entry" contenteditable="true" role="textbox" aria-label="作业内容" data-tags="${htmlEscape(selectedTagIds.join(","))}">${content}${renderInlineTagBadges(selectedTagIds)}</li>`;
}

function renderInlineTagBadges(selectedTagIds: string[]): string {
  return selectedTagIds.map((id) => {
    const tag = settings.Pages.Tags.items.find((item) => item.Id === id);
    if (!tag) return "";
    const color = /^#[0-9a-f]{6}$/i.test(tag.Color) ? tag.Color : DEFAULT_TAG_COLOR;
    return `<span class="homework-tag-badge" contenteditable="false" style="--tag-color:${color};--tag-text-color:${getTagTextColor(color)}">${htmlEscape(tag.Name)}</span>`;
  }).join("");
}

function renderSelectedTagBadges(selectedTagIds: string[]): string {
  return selectedTagIds.map((id) => {
    const tag = settings.Pages.Tags.items.find((item) => item.Id === id);
    if (!tag) return "";
    const color = /^#[0-9a-f]{6}$/i.test(tag.Color) ? tag.Color : DEFAULT_TAG_COLOR;
    return `<span class="homework-tag-badge" style="--tag-color:${color};--tag-text-color:${getTagTextColor(color)}">${htmlEscape(tag.Name)}</span>`;
  }).join("");
}

function getTagTextColor(hex: string): string {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.68 ? "#1f2d3d" : "#ffffff";
}

function renderSubjectDialog(): string {
  if (subjectDialogOpen === undefined) return "";
  const subject = settings.Pages.Subjects.items.find((item) => item.Id === subjectDialogOpen);
  return `
    <div class="modal-backdrop subject-modal-backdrop">
      <section class="subject-dialog" role="dialog" aria-modal="true" aria-labelledby="subject-dialog-title">
        <h2 id="subject-dialog-title">${subject ? "编辑科目" : "添加科目"}</h2>
        <label class="field-label" for="subject-name">科目名称</label>
        <input id="subject-name" class="text-field" maxlength="32" value="${htmlEscape(subject?.Name ?? "")}" placeholder="例如：数学">
        <footer class="dialog-footer"><button class="text-button" data-action="cancel-subject">取消</button><button class="primary-button" data-action="save-subject">保存</button></footer>
      </section>
    </div>`;
}

let subjectDialogOpen: string | null | undefined;

function renderSettings(): void {
  if (!root) return;
  const subjectPage = settingsPage === "Subjects";
  const tagPage = settingsPage === "Tags";
  const nativePopup = isTauri() && viewMode === "settings";
  const content = subjectPage ? renderSubjectsPage() : tagPage ? renderTagsPage() : renderBasicPage();
  root.innerHTML = `
    <main class="settings-shell">
      ${nativePopup ? "" : `<header class="settings-titlebar"><span class="settings-app-icon">${icon("settings")}</span><span>应用设置</span><span class="settings-window-caption">作业板设置</span><button class="icon-button settings-close" data-action="settings-close" aria-label="关闭设置">${icon("close")}</button></header>`}
      <header class="settings-banner"><h1>应用设置</h1><span>作业板</span></header>
      <div class="settings-layout">
        <nav class="settings-nav" aria-label="设置页面">
          <button class="settings-nav-item ${!subjectPage && !tagPage ? "selected" : ""}" data-page="Basic">基本</button>
          <button class="settings-nav-item ${subjectPage ? "selected" : ""}" data-page="Subjects">科目</button>
          <button class="settings-nav-item ${tagPage ? "selected" : ""}" data-page="Tags">标签</button>
          <div class="settings-nav-spacer"></div><span class="settings-nav-note">更多设置将在后续版本开放</span>
        </nav>
        <section class="settings-content">${content}</section>
      </div>
      ${renderSubjectDialog()}
      <div id="toast" class="toast settings-toast" role="status" aria-live="polite"></div>
    </main>`;
  attachSettingsEvents();
}

function renderBasicPage(): string {
  const basic = settings.Pages.Basic;
  return `
    <div class="settings-section-heading">${icon("settings")}<h2>基本</h2></div>
    <div class="settings-card toggle-card"><span class="setting-icon">${icon("pin")}</span><div class="setting-copy"><strong>窗口置底</strong><span>作业板固定在桌面底层，不会遮挡其他窗口。</span></div><span class="setting-fixed-value">始终开启</span></div>
    <label class="settings-card input-card"><span class="setting-icon">${icon("image")}</span><span class="setting-copy"><strong>窗口标题</strong><span>在作业板窗口上显示的标题。</span></span><input class="settings-inline-input" data-setting="windowTitle" maxlength="24" value="${htmlEscape(basic.windowTitle)}" aria-label="窗口标题"></label>
    <label class="settings-card input-card export-path-card"><span class="setting-icon">${icon("quick")}</span><span class="setting-copy"><strong>快捷导出图片路径</strong><span>选择图片保存目录；留空时使用系统图片目录。</span></span><input class="settings-inline-input path-input" data-setting="quickExportPath" value="${htmlEscape(basic.quickExportPath)}" placeholder="留空则保存到图片文件夹" aria-label="快捷导出图片路径"></label>
    <div class="settings-section-heading secondary-heading">${icon("pin")}<h2>窗口行为</h2></div>
    <div class="settings-note-card">窗口锁定时可以编辑作业；解锁后可拖动窗口，编辑功能会暂时停用。</div>`;
}

function renderSubjectsPage(): string {
  const items = settings.Pages.Subjects.items;
  return `
    <div class="subjects-heading"><div><span class="page-eyebrow">HOMEWORK ORGANIZATION</span><h2>科目</h2><p>管理作业板中显示的科目。</p></div><button class="add-subject-button" data-action="add-subject">${icon("add")}<span>添加科目</span></button></div>
    <div class="subject-settings-list">
      ${items.length ? items.map((item) => `<section class="subject-setting-card">
        <header class="subject-setting-row"><span class="subject-color-dot"></span><span class="subject-setting-name">${htmlEscape(item.Name)}</span><button class="row-icon-button" data-action="edit-subject" data-id="${item.Id}" aria-label="编辑${htmlEscape(item.Name)}">${icon("edit")}</button><button class="row-icon-button delete-button" data-action="delete-subject" data-id="${item.Id}" aria-label="删除${htmlEscape(item.Name)}">${icon("trash")}</button></header>
        <div class="subject-quick-field-editor">
          <form class="quick-field-add" data-quick-field-form="${item.Id}"><input class="quick-field-input" maxlength="32" placeholder="添加作业快捷字段" aria-label="为${htmlEscape(item.Name)}添加快捷字段"><button class="quick-field-add-button" type="submit" aria-label="添加快捷字段">${icon("add")}</button></form>
          <div class="subject-quick-field-list">${item.QuickFields.map((field, index) => `<div class="subject-quick-field-item"><span>${htmlEscape(field)}</span><button class="row-icon-button delete-button" data-action="delete-quick-field" data-id="${item.Id}" data-index="${index}" aria-label="删除快捷字段${htmlEscape(field)}">${icon("trash")}</button></div>`).join("") || `<span class="quick-field-empty">还没有快捷字段</span>`}</div>
        </div>
      </section>`).join("") : `<div class="subjects-empty"><strong>还没有添加科目</strong><span>添加科目后即可开始布置作业。</span></div>`}
    </div>`;
}

function renderTagsPage(): string {
  return `
    <div class="subjects-heading"><div><span class="page-eyebrow">HOMEWORK LABELS</span><h2>标签</h2><p>自定义作业标签的名称和颜色，标签会显示在每条作业旁。</p></div></div>
    <form class="tag-add-form" id="tag-add-form">
      <input class="tag-name-input" name="name" maxlength="24" placeholder="添加标签名称" aria-label="标签名称">
      <label class="tag-color-picker" title="选择标签颜色"><span>颜色</span><input type="color" name="color" value="${DEFAULT_TAG_COLOR}" aria-label="新标签颜色"></label>
      <button class="primary-button" type="submit">${icon("add")}<span>添加标签</span></button>
    </form>
    <div class="tag-settings-list">
      ${settings.Pages.Tags.items.length
        ? settings.Pages.Tags.items.map((tag) => `<div class="tag-setting-row" data-tag-row="${tag.Id}">
          <span class="tag-preview" style="--tag-color:${tag.Color};--tag-text-color:${getTagTextColor(tag.Color)}">${htmlEscape(tag.Name)}</span>
            <input class="tag-setting-name" data-tag-name="${tag.Id}" maxlength="24" value="${htmlEscape(tag.Name)}" aria-label="标签名称">
            <label class="tag-color-picker" title="修改${htmlEscape(tag.Name)}颜色"><span>颜色</span><input type="color" data-tag-color="${tag.Id}" value="${tag.Color}" aria-label="${htmlEscape(tag.Name)}颜色"></label>
            <button class="row-icon-button delete-button" data-action="delete-tag" data-id="${tag.Id}" aria-label="删除标签${htmlEscape(tag.Name)}">${icon("trash")}</button>
          </div>`).join("")
        : `<div class="subjects-empty"><strong>还没有标签</strong><span>添加标签后，可在编辑作业时为每条作业单独标记。</span></div>`}
    </div>`;
}

async function handleBoardAction(action: string, subjectId?: string): Promise<void> {
  switch (action) {
    case "menu":
      menuOpen = !menuOpen;
      renderBoard();
      break;
    case "lock":
      locked = !locked;
      renderBoard();
      break;
    case "toggle-expired":
      if (locked) {
        viewingExpired = !viewingExpired;
        menuOpen = false;
        renderBoard();
      }
      break;
    case "undo":
      if (undoSnapshot && locked) {
        homework = undoSnapshot;
        undoSnapshot = null;
        await saveHomework();
        renderBoard();
        showToast("已撤销上一步操作");
      }
      break;
    case "add":
      if (locked) {
        const availableSubjects = settings.Pages.Subjects.items.filter(
          (subject) => !hasActiveHomework(subject.Id),
        );
        if (availableSubjects.length === 1) {
          await openPopup("editor", availableSubjects[0].Id);
          if (!isTauri()) await openEditor(availableSubjects[0].Id);
        } else {
          subjectPickerOpen = true;
          renderBoard();
        }
      }
      break;
    case "cancel-subject-picker":
      subjectPickerOpen = false;
      renderBoard();
      break;
    case "pick-subject": {
      if (subjectId) {
        subjectPickerOpen = false;
        if (isTauri()) await openPopup("editor", subjectId);
        else await openEditor(subjectId);
      }
      break;
    }
    case "settings":
      if (locked) {
        menuOpen = false;
        if (isTauri()) {
          renderBoard();
          await openPopup("settings");
        }
        else renderSettings();
      }
      break;
    case "cancel-editor":
      if (viewMode === "editor") await closeCurrentWindow();
      else {
        editingSubjectId = null;
        editingRecords = [];
        renderBoard();
      }
      break;
    case "save-editor":
      await saveEditor();
      break;
    case "delete-editor":
      await deleteEditor();
      break;
    case "clear":
      if (locked && Object.keys(homework).length && window.confirm("确定要清除所有作业吗？")) {
        undoSnapshot = structuredClone(homework);
        homework = {};
        await saveHomework();
        renderBoard();
        showToast("作业已清除，可以点击撤销恢复");
      }
      break;
    case "zoom-in":
    case "zoom-out":
      settings.Pages.Basic.zoom = Math.max(
        70,
        Math.min(150, settings.Pages.Basic.zoom + (action === "zoom-in" ? 10 : -10)),
      );
      await saveSettings();
      renderBoard();
      await resizeForZoom();
      break;
    case "content-larger":
    case "content-smaller":
      settings.Pages.Basic.contentScale = Math.max(
        80,
        Math.min(150, settings.Pages.Basic.contentScale + (action === "content-larger" ? 10 : -10)),
      );
      await saveSettings();
      renderBoard();
      break;
    case "export":
      await exportBoard(false);
      break;
    case "quick-export":
      await exportBoard(true);
      break;
    case "minimize":
      if (isTauri()) await getCurrentWindow().hide();
      break;
    case "close":
      menuOpen = false;
      if (isTauri()) {
        await Promise.all([saveSettings(), saveHomework()]);
        await invoke("exit_application");
      } else {
        showToast("作业已自动保存；关闭应用请关闭浏览器标签页");
      }
      break;
  }
}

async function openEditor(subjectId?: string): Promise<void> {
  return openSubjectEditor(subjectId, false);
}

async function openSubjectEditor(subjectId: string | undefined, expiredOnly: boolean): Promise<void> {
  const subject = settings.Pages.Subjects.items.find((item) => item.Id === subjectId);
  if (!subject) {
    showToast("请先在设置中添加一个科目");
    return;
  }
  if (isTauri()) {
    await openPopup("editor", subject.Id, expiredOnly);
    return;
  }
  subjectPickerOpen = false;
  editingSubjectId = subject.Id;
  editingExpiredOnly = expiredOnly;
  editingRecords = Object.values(homework).filter((item) => (
    item.SubjectId === subject.Id && isHomeworkExpired(item) === expiredOnly
  ));
  renderBoard();
  document.querySelector<HTMLElement>(".homework-entry")?.focus();
}

function getEditorLines(): Array<{ ContentHtml: string; Tags: string[] }> {
  const editor = document.querySelector<HTMLElement>("#rich-editor");
  if (!editor) return [];
  return Array.from(editor.querySelectorAll<HTMLLIElement>(".homework-entry")).map((line) => {
    const content = line.cloneNode(true) as HTMLLIElement;
    content.querySelectorAll(".homework-tag-badge").forEach((badge) => badge.remove());
    return {
      ContentHtml: sanitizeRichHtml(content.innerHTML),
      Tags: (line.dataset.tags ?? "").split(",").filter((tagId) => (
        tagId && settings.Pages.Tags.items.some((tag) => tag.Id === tagId)
      )),
    };
  }).filter(({ ContentHtml, Tags }) => (
    ContentHtml.replace(/<br\s*\/?>/gi, "").trim() !== "" || Tags.length > 0
  ));
}

function sanitizeRichHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const allowed = new Set(["B", "STRONG", "I", "EM", "U", "SPAN", "FONT", "BR"]);
  const clean = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return htmlEscape(node.textContent ?? "");
    if (!(node instanceof HTMLElement)) return "";
    const children = Array.from(node.childNodes).map(clean).join("");
    if (!allowed.has(node.tagName)) return children;
    if (node.tagName === "SPAN" || node.tagName === "FONT") {
      const color = node.tagName === "FONT" ? node.getAttribute("color") ?? "" : node.style.color;
      return /^#[0-9a-f]{3,8}$/i.test(color) || /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/.test(color)
        ? `<span style="color:${color}">${children}</span>`
        : children;
    }
    return node.tagName === "BR" ? "<br>" : `<${node.tagName.toLowerCase()}>${children}</${node.tagName.toLowerCase()}>`;
  };
  return Array.from(parsed.body.childNodes).map(clean).join("").trim();
}

async function saveEditor(): Promise<void> {
  const subjectSelect = document.querySelector<HTMLSelectElement>("#homework-subject");
  const dueInput = document.querySelector<HTMLInputElement>("#homework-due");
  const subjectId = subjectSelect?.value;
  if (!subjectId || !dueInput?.value) {
    showToast("请选择科目和过期时间");
    return;
  }
  const earliestDueDate = todayPlusOne();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueInput.value) || dueInput.value < earliestDueDate) {
    showToast("过期时间最早只能设置为明天");
    dueInput.min = earliestDueDate;
    return;
  }
  const lines = getEditorLines();
  if (!lines.length && !editingRecords.length) {
    showToast("请至少填写一条作业内容");
    return;
  }
  const nextRecords: HomeworkItem[] = lines.map(({ ContentHtml, Tags }, index) => {
    const old = editingRecords[index];
    const timestamp = new Date().toISOString();
    return {
      Id: old?.Id ?? crypto.randomUUID(),
      SubjectId: subjectId,
      ContentHtml,
      DueAt: dueInput.value,
      CreatedAt: old?.CreatedAt ?? timestamp,
      UpdatedAt: timestamp,
      Tags,
    };
  });
  const latestHomework = (await readFile<Record<string, HomeworkItem>>("Homework.json", HOMEWORK_KEY)) ?? {};
  const updated = { ...latestHomework };
  editingRecords.forEach((item) => delete updated[item.Id]);
  nextRecords.forEach((item) => (updated[item.Id] = item));
  const previousHomework = homework;
  const previousUndoSnapshot = undoSnapshot;
  undoSnapshot = structuredClone(latestHomework);
  homework = updated;
  try {
    await saveHomework();
  } catch (error) {
    homework = previousHomework;
    undoSnapshot = previousUndoSnapshot;
    throw error;
  }
  if (viewMode === "editor") {
    await closeCurrentWindow();
    return;
  }
  editingSubjectId = null;
  editingRecords = [];
  editingExpiredOnly = false;
  renderBoard();
  showToast(lines.length ? "作业已保存" : "该科目的作业已清空");
}

async function deleteEditor(): Promise<void> {
  if (!editingSubjectId || !editingRecords.length) return;
  const subject = settings.Pages.Subjects.items.find((item) => item.Id === editingSubjectId);
  if (!window.confirm(`确定删除${subject ? `“${subject.Name}”` : "该科目"}当前${editingExpiredOnly ? "过期" : ""}作业吗？`)) return;

  const latestHomework = (await readFile<Record<string, HomeworkItem>>("Homework.json", HOMEWORK_KEY)) ?? {};
  const previousHomework = homework;
  undoSnapshot = structuredClone(latestHomework);
  const removedIds = new Set(editingRecords.map((item) => item.Id));
  homework = Object.fromEntries(Object.entries(latestHomework).filter(([id]) => !removedIds.has(id)));
  try {
    await saveHomework();
    if (viewMode === "editor") {
      await closeCurrentWindow();
      return;
    }
    editingSubjectId = null;
    editingRecords = [];
    editingExpiredOnly = false;
    renderBoard();
    showToast("作业已删除，可以点击撤销恢复");
  } catch (error) {
    homework = previousHomework;
    undoSnapshot = null;
    throw error;
  }
}

function attachEditorEvents(): void {
  const editor = document.querySelector<HTMLElement>("#rich-editor");
  root?.querySelectorAll<HTMLButtonElement>("[data-format]").forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const line = getActiveEditorLine(editor);
      if (!line) return;
      line.focus();
      document.execCommand(button.dataset.format ?? "", false);
      line.focus();
    });
  });
  document.querySelector<HTMLInputElement>("[data-color-picker]")?.addEventListener("input", (event) => {
    const line = getActiveEditorLine(editor);
    if (!line) return;
    line.focus();
    document.execCommand("foreColor", false, (event.currentTarget as HTMLInputElement).value);
  });
  root?.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const line = getActiveEditorLine(editor);
      if (!line) return;
      line.focus();
      document.execCommand("foreColor", false, button.dataset.color ?? "#000000");
    });
  });
  root?.querySelectorAll<HTMLButtonElement>("[data-homework-tag]").forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const entry = getActiveEditorLine(editor);
      if (!editor || !entry) return;
      const tagId = button.dataset.homeworkTag;
      if (!tagId) return;
      const selectedTags = new Set((entry.dataset.tags ?? "").split(",").filter(Boolean));
      if (selectedTags.has(tagId)) selectedTags.delete(tagId);
      else selectedTags.add(tagId);
      entry.dataset.tags = [...selectedTags].join(",");
      renderLineTagBadges(entry, [...selectedTags]);
      updateTagControlState(editor, entry);
      entry.focus();
      placeCaretBeforeTags(entry);
    });
  });
  editor?.addEventListener("focusin", (event) => {
    const entry = (event.target as HTMLElement).closest<HTMLElement>(".homework-entry");
    if (entry) updateTagControlState(editor, entry);
  });
  root?.querySelectorAll<HTMLButtonElement>("[data-quick-field], [data-keypad]").forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const field = button.dataset.quickField;
      const key = button.dataset.keypad;
      if (field !== undefined) {
        insertEditorText(field);
      } else if (key === "backspace") {
        backspaceEditorLine(editor);
      } else if (key === "space") {
        insertEditorText(" ");
      } else if (key === "enter") {
        insertEditorNewLine(editor);
      } else if (key !== undefined) {
        insertEditorText(key);
      }
    });
  });
  editor?.addEventListener("keydown", (event) => {
    const line = (event.target as HTMLElement).closest<HTMLElement>(".homework-entry");
    if (!line) return;
    if (event.key === "Enter") {
      event.preventDefault();
      splitEditorLine(line);
    } else if (event.key === "Backspace" && mergeEditorLineBackward(line)) {
      event.preventDefault();
    }
  });
  root?.querySelector("[data-modal-backdrop='editor']")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      editingSubjectId = null;
      editingRecords = [];
      renderBoard();
    }
  });
  root?.querySelector("[data-modal-backdrop='subject-picker']")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      subjectPickerOpen = false;
      renderBoard();
    }
  });
}

function updateTagControlState(editor: HTMLElement, entry: HTMLElement): void {
  const selectedTags = new Set((entry.dataset.tags ?? "").split(",").filter(Boolean));
  editor.parentElement?.querySelectorAll<HTMLButtonElement>("[data-homework-tag]").forEach((button) => {
    const selected = Boolean(button.dataset.homeworkTag && selectedTags.has(button.dataset.homeworkTag));
    button.setAttribute("aria-pressed", String(selected));
    button.classList.toggle("selected", selected);
  });
}

function getActiveEditorLine(editor: HTMLElement | null): HTMLElement | null {
  if (!editor) return null;
  const selection = window.getSelection();
  if (selection?.rangeCount && editor.contains(selection.anchorNode)) {
    const active = selection.anchorNode instanceof HTMLElement
      ? selection.anchorNode.closest<HTMLElement>(".homework-entry")
      : selection.anchorNode?.parentElement?.closest<HTMLElement>(".homework-entry");
    if (active) return active;
  }
  return editor.querySelector<HTMLElement>(".homework-entry");
}

function focusEditorAtSelection(editor: HTMLElement | null): HTMLElement | null {
  const line = getActiveEditorLine(editor);
  if (!line) return null;
  const selection = window.getSelection();
  if (selection?.rangeCount && line.contains(selection.anchorNode)) {
    line.focus();
    return line;
  }
  line.focus();
  const range = document.createRange();
  range.selectNodeContents(line);
  const lastBadge = line.querySelector(".homework-tag-badge:last-of-type");
  if (lastBadge) range.setStartBefore(lastBadge);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
  return line;
}

function insertEditorText(text: string): void {
  const editor = document.querySelector<HTMLElement>("#rich-editor");
  if (!focusEditorAtSelection(editor)) return;
  document.execCommand("insertText", false, text);
}

function insertEditorNewLine(editor: HTMLElement | null): void {
  const lineEditor = focusEditorAtSelection(editor);
  if (lineEditor) splitEditorLine(lineEditor);
}

function splitEditorLine(lineEditor: HTMLElement): void {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!range || !lineEditor.contains(range.startContainer)) return;
  const tags = (lineEditor.dataset.tags ?? "").split(",").filter(Boolean);
  const firstBadge = lineEditor.querySelector(".homework-tag-badge");
  if (firstBadge && range.compareBoundaryPoints(Range.START_TO_START, (() => {
    const end = document.createRange();
    end.setStartBefore(firstBadge);
    end.collapse(true);
    return end;
  })()) > 0) {
    range.setStartBefore(firstBadge);
  }
  range.deleteContents();
  const remainderRange = range.cloneRange();
  if (firstBadge) remainderRange.setEndBefore(firstBadge);
  else remainderRange.setEnd(lineEditor, lineEditor.childNodes.length);
  const remainder = remainderRange.extractContents();
  lineEditor.querySelectorAll(".homework-tag-badge").forEach((badge) => badge.remove());
  renderLineTagBadges(lineEditor, tags);
  const template = document.createElement("ul");
  template.innerHTML = renderHomeworkLine("", []);
  const nextEntry = template.firstElementChild;
  if (!(nextEntry instanceof HTMLLIElement)) return;
  nextEntry.replaceChildren(remainder);
  if (!nextEntry.hasChildNodes()) nextEntry.innerHTML = "<br>";
  lineEditor.after(nextEntry);
  const nextRange = document.createRange();
  nextRange.selectNodeContents(nextEntry);
  nextRange.collapse(true);
  nextEntry.focus();
  selection?.removeAllRanges();
  selection?.addRange(nextRange);
}

function renderLineTagBadges(line: HTMLElement, tagIds: string[]): void {
  line.querySelectorAll(".homework-tag-badge").forEach((badge) => badge.remove());
  const template = document.createElement("div");
  template.innerHTML = renderInlineTagBadges(tagIds);
  line.append(...Array.from(template.childNodes));
}

function placeCaretBeforeTags(line: HTMLElement): void {
  const selection = window.getSelection();
  const range = document.createRange();
  const firstBadge = line.querySelector(".homework-tag-badge");
  if (firstBadge) range.setStartBefore(firstBadge);
  else range.selectNodeContents(line);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function mergeEditorLineBackward(line: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !line.contains(range.startContainer)) return false;
  const start = document.createRange();
  start.selectNodeContents(line);
  start.collapse(true);
  if (range.compareBoundaryPoints(Range.START_TO_START, start) !== 0) return false;
  const previous = line.previousElementSibling as HTMLElement | null;
  if (!previous?.classList.contains("homework-entry")) return false;
  const mergedTags = new Set([
    ...(previous.dataset.tags ?? "").split(",").filter(Boolean),
    ...(line.dataset.tags ?? "").split(",").filter(Boolean),
  ]);
  const currentContent = line.cloneNode(true) as HTMLElement;
  currentContent.querySelectorAll(".homework-tag-badge").forEach((badge) => badge.remove());
  const previousContent = previous.cloneNode(true) as HTMLElement;
  previousContent.querySelectorAll(".homework-tag-badge").forEach((badge) => badge.remove());
  const currentIsEmpty = !currentContent.textContent?.trim();
  const previousIsEmpty = !previousContent.textContent?.trim();
  const fragment = document.createDocumentFragment();
  const contentNodes = Array.from(line.childNodes).filter((node) => (
    !(node instanceof HTMLElement && node.classList.contains("homework-tag-badge"))
      && !(currentIsEmpty && node instanceof HTMLBRElement)
  ));
  contentNodes.forEach((node) => fragment.append(node));
  if (previousIsEmpty) previous.querySelectorAll(":scope > br").forEach((placeholder) => placeholder.remove());
  const previousBadges = previous.querySelector(".homework-tag-badge");
  const insertionPoint = document.createRange();
  if (previousBadges) insertionPoint.setStartBefore(previousBadges);
  else {
    insertionPoint.selectNodeContents(previous);
    insertionPoint.collapse(false);
  }
  insertionPoint.collapse(true);
  const lastMovedNode = fragment.lastChild;
  insertionPoint.insertNode(fragment);
  previous.dataset.tags = [...mergedTags].join(",");
  renderLineTagBadges(previous, [...mergedTags]);
  line.remove();
  if (lastMovedNode?.parentNode === previous) insertionPoint.setStartAfter(lastMovedNode);
  else {
    const previousBadge = previous.querySelector(".homework-tag-badge");
    if (previousBadge) insertionPoint.setStartBefore(previousBadge);
  }
  insertionPoint.collapse(true);
  previous.focus();
  selection.removeAllRanges();
  selection.addRange(insertionPoint);
  const editor = document.querySelector<HTMLElement>("#rich-editor");
  if (editor) updateTagControlState(editor, previous);
  return true;
}

function backspaceEditorLine(editor: HTMLElement | null): void {
  const line = focusEditorAtSelection(editor);
  if (!line) return;
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (range?.collapsed && mergeEditorLineBackward(line)) return;
  document.execCommand("delete", false);
}

function attachBoardEvents(): void {
  root?.querySelectorAll<HTMLElement>("[data-action]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (button.dataset.action === "save-editor") {
        void saveEditor().catch((error: unknown) => showToast(`保存作业失败：${String(error)}`));
        return;
      }
      if (button.dataset.action === "cancel-editor") {
        if (viewMode === "editor") {
          void closeCurrentWindow().catch((error: unknown) => showToast(`关闭作业窗口失败：${String(error)}`));
        } else {
          editingSubjectId = null;
          editingRecords = [];
          renderBoard();
        }
        return;
      }
      void handleBoardAction(button.dataset.action ?? "", button.dataset.id).catch((error: unknown) => {
        showToast(`操作失败：${String(error)}`);
      });
    });
  });
  root?.querySelectorAll<HTMLElement>("[data-drag-handle]").forEach((element) => {
    element.addEventListener("pointerdown", (event) => {
      if (locked || !isTauri() || (event.target as HTMLElement).closest("button")) return;
      void getCurrentWindow().startDragging().catch((error: unknown) => showToast(`移动窗口失败：${String(error)}`));
    });
  });
  root?.querySelectorAll<HTMLButtonElement>("[data-subject-card]").forEach((card) => {
    card.addEventListener("click", () => {
      if (locked) {
        void openSubjectEditor(card.dataset.subjectCard, viewingExpired).catch((error: unknown) => {
          showToast(`打开作业窗口失败：${String(error)}`);
        });
      }
    });
  });
  attachEditorEvents();
}

function attachSettingsEvents(): void {
  root?.querySelectorAll<HTMLButtonElement>("[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      const page = button.dataset.page;
      settingsPage = page === "Subjects" || page === "Tags" ? page : "Basic";
      renderSettings();
    });
  });
  root?.querySelectorAll<HTMLElement>("[data-action]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const action = button.dataset.action;
      if (action === "settings-close") {
        if (viewMode === "settings") {
          void closeCurrentWindow().catch((error: unknown) => showToast(`关闭设置窗口失败：${String(error)}`));
        } else {
          renderBoard();
        }
      } else if (action === "add-subject") {
        subjectDialogOpen = null;
        renderSettings();
        document.querySelector<HTMLInputElement>("#subject-name")?.focus();
      } else if (action === "edit-subject") {
        subjectDialogOpen = button.dataset.id ?? null;
        renderSettings();
        document.querySelector<HTMLInputElement>("#subject-name")?.focus();
      } else if (action === "cancel-subject") {
        subjectDialogOpen = undefined;
        renderSettings();
      } else if (action === "save-subject") {
        void saveSubject();
      } else if (action === "delete-subject") {
        void deleteSubject(button.dataset.id ?? "");
      } else if (action === "delete-quick-field") {
        void deleteQuickField(button.dataset.id ?? "", Number(button.dataset.index));
      } else if (action === "delete-tag") {
        void deleteTag(button.dataset.id ?? "");
      }
    });
  });
  root?.querySelector<HTMLFormElement>("#tag-add-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const name = form.querySelector<HTMLInputElement>("[name='name']")?.value ?? "";
    const color = form.querySelector<HTMLInputElement>("[name='color']")?.value ?? DEFAULT_TAG_COLOR;
    void addTag(name, color);
  });
  root?.querySelectorAll<HTMLInputElement>("[data-tag-name]").forEach((input) => {
    input.addEventListener("change", () => void updateTag(input.dataset.tagName ?? "", input.value));
  });
  root?.querySelectorAll<HTMLInputElement>("[data-tag-color]").forEach((input) => {
    input.addEventListener("change", () => {
      const tagId = input.dataset.tagColor ?? "";
      void updateTag(tagId, undefined, input.value);
    });
  });
  root?.querySelectorAll<HTMLFormElement>("[data-quick-field-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void addQuickField(form.dataset.quickFieldForm ?? "", form.querySelector<HTMLInputElement>("input")?.value ?? "");
    });
  });
  root?.querySelectorAll<HTMLInputElement>("[data-setting]").forEach((input) => {
    input.addEventListener("change", () => void updateSetting(input));
    if (input.type === "range") {
      input.addEventListener("input", () => {
        const output = input.parentElement?.querySelector("output");
        if (output) output.textContent = `${input.value}%`;
      });
    }
  });
}

async function updateSetting(input: HTMLInputElement): Promise<void> {
  const field = input.dataset.setting;
  if (field === "windowTitle") settings.Pages.Basic.windowTitle = input.value.trim() || "作业";
  if (field === "quickExportPath") settings.Pages.Basic.quickExportPath = input.value.trim();
  try {
    await saveSettings();
    if (field === "windowTitle") renderSettings();
  } catch (error) {
    showToast(`保存设置失败：${String(error)}`);
  }
}

async function saveSubject(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>("#subject-name");
  const name = input?.value.trim();
  if (!name) {
    showToast("请输入科目名称");
    return;
  }
  const existing = subjectDialogOpen
    ? settings.Pages.Subjects.items.find((item) => item.Id === subjectDialogOpen)
    : undefined;
  const duplicate = settings.Pages.Subjects.items.some(
    (item) => item.Name.toLocaleLowerCase() === name.toLocaleLowerCase() && item.Id !== existing?.Id,
  );
  if (duplicate) {
    showToast("这个科目已经存在");
    return;
  }
  const previousSubjects = structuredClone(settings.Pages.Subjects.items);
  if (existing) existing.Name = name;
  else settings.Pages.Subjects.items.push({ Id: crypto.randomUUID(), Name: name, QuickFields: [] });
  try {
    await saveSettings();
    subjectDialogOpen = undefined;
    renderSettings();
  } catch (error) {
    settings.Pages.Subjects.items = previousSubjects;
    showToast(`保存科目失败：${String(error)}`);
  }
}

async function addQuickField(subjectId: string, value: string): Promise<void> {
  const subject = settings.Pages.Subjects.items.find((item) => item.Id === subjectId);
  const field = value.trim();
  if (!subject || !field) return;
  if (subject.QuickFields.some((item) => item.toLocaleLowerCase() === field.toLocaleLowerCase())) {
    showToast("这个快捷字段已经存在");
    return;
  }
  const previousFields = [...subject.QuickFields];
  subject.QuickFields.push(field);
  try {
    await saveSettings();
    renderSettings();
    root?.querySelector<HTMLInputElement>(`[data-quick-field-form="${subjectId}"] input`)?.focus();
  } catch (error) {
    subject.QuickFields = previousFields;
    showToast(`添加快捷字段失败：${String(error)}`);
  }
}

async function deleteQuickField(subjectId: string, index: number): Promise<void> {
  const subject = settings.Pages.Subjects.items.find((item) => item.Id === subjectId);
  if (!subject || !Number.isInteger(index) || index < 0 || index >= subject.QuickFields.length) return;
  const previousFields = [...subject.QuickFields];
  subject.QuickFields.splice(index, 1);
  try {
    await saveSettings();
    renderSettings();
  } catch (error) {
    subject.QuickFields = previousFields;
    showToast(`删除快捷字段失败：${String(error)}`);
  }
}

async function addTag(value: string, color: string): Promise<void> {
  const name = value.trim();
  if (!name) {
    showToast("请输入标签名称");
    return;
  }
  if (settings.Pages.Tags.items.some((tag) => tag.Name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    showToast("这个标签已经存在");
    return;
  }
  settings.Pages.Tags.items.push({ Id: crypto.randomUUID(), Name: name, Color: color });
  try {
    await saveSettings();
    renderSettings();
  } catch (error) {
    settings.Pages.Tags.items.pop();
    renderSettings();
    showToast(`添加标签失败：${String(error)}`);
  }
}

async function updateTag(tagId: string, name?: string, color?: string): Promise<void> {
  const tag = settings.Pages.Tags.items.find((item) => item.Id === tagId);
  if (!tag) return;
  const nextName = name?.trim();
  if (name !== undefined && !nextName) {
    showToast("标签名称不能为空");
    renderSettings();
    return;
  }
  if (nextName && settings.Pages.Tags.items.some((item) => (
    item.Id !== tagId && item.Name.toLocaleLowerCase() === nextName.toLocaleLowerCase()
  ))) {
    showToast("这个标签已经存在");
    renderSettings();
    return;
  }
  const previous = { ...tag };
  if (nextName) tag.Name = nextName;
  if (color && /^#[0-9a-f]{6}$/i.test(color)) tag.Color = color;
  try {
    await saveSettings();
    renderSettings();
  } catch (error) {
    Object.assign(tag, previous);
    renderSettings();
    showToast(`保存标签失败：${String(error)}`);
  }
}

async function deleteTag(tagId: string): Promise<void> {
  const index = settings.Pages.Tags.items.findIndex((item) => item.Id === tagId);
  if (index < 0) return;
  const [tag] = settings.Pages.Tags.items.splice(index, 1);
  try {
    await saveSettings();
    renderSettings();
  } catch (error) {
    settings.Pages.Tags.items.splice(index, 0, tag);
    renderSettings();
    showToast(`删除标签失败：${String(error)}`);
  }
}

async function deleteSubject(id: string): Promise<void> {
  const subject = settings.Pages.Subjects.items.find((item) => item.Id === id);
  if (!subject) return;
  if (Object.values(homework).some((item) => item.SubjectId === id)) {
    showToast("该科目还有未完成的作业，请先处理作业内容");
    return;
  }
  if (!window.confirm(`确定删除科目“${subject.Name}”吗？`)) return;
  settings.Pages.Subjects.items = settings.Pages.Subjects.items.filter((item) => item.Id !== id);
  try {
    await saveSettings();
    renderSettings();
  } catch (error) {
    showToast(`删除科目失败：${String(error)}`);
  }
}

async function applyWindowSettings(): Promise<void> {
  if (!isTauri()) return;
  const currentWindow = getCurrentWindow();
  await currentWindow.setAlwaysOnBottom(true);
  await currentWindow.setResizable(!locked);
}

async function resizeForZoom(): Promise<void> {
  if (!isTauri()) return;
  const zoom = settings.Pages.Basic.zoom / 100;
  await getCurrentWindow().setSize(new LogicalSize(540 * zoom, 360 * zoom));
}

function serializeBoardSvg(): string {
  const width = 720;
  const contentScale = settings.Pages.Basic.contentScale / 100;
  const boardGroups = settings.Pages.Subjects.items
    .map((subject) => ({
      subject,
      items: Object.values(homework).filter((item) => item.SubjectId === subject.Id),
    }))
    .filter(({ items }) => items.length);
  const lineCount = boardGroups.reduce((total, group) => total + group.items.length + 1, 0);
  const height = Math.max(220, lineCount * 44 + 70);
  let y = 48;
  const text = boardGroups.map(({ subject, items }) => {
    const heading = `<text x="28" y="${y}" font-size="${28 * contentScale}" font-weight="700" fill="#24364b">${htmlEscape(subject.Name)}</text>`;
    y += 38;
    const lines = items.map((item) => {
      const textNode = document.createElement("div");
      textNode.innerHTML = sanitizeRichHtml(item.ContentHtml);
      const safeText = htmlEscape(textNode.textContent ?? "");
      const line = `<text x="54" y="${y}" font-size="${22 * contentScale}" fill="#293b50">· ${safeText}</text>`;
      y += 38;
      return line;
    }).join("");
    y += 8;
    return heading + lines;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#edf5fc"/><rect width="100%" height="40" fill="#0878d1"/><text x="18" y="27" fill="white" font-size="19" font-weight="700">${htmlEscape(settings.Pages.Basic.windowTitle)}</text>${text}</svg>`;
}

async function exportBoard(quick: boolean): Promise<void> {
  try {
    const svg = new Blob([serializeBoardSvg()], { type: "image/svg+xml;charset=utf-8" });
    const image = new Image();
    image.src = URL.createObjectURL(svg);
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("无法生成作业板图片"));
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前环境不支持图片导出");
    context.drawImage(image, 0, 0);
    URL.revokeObjectURL(image.src);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error("图片编码失败")), "image/png");
    });
    if (quick && isTauri()) {
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      const savedPath = await invoke<string>("save_export_image", {
        directory: settings.Pages.Basic.quickExportPath || null,
        bytes,
      });
      showToast(`图片已保存：${savedPath}`);
      return;
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `作业板-${new Date().toISOString().slice(0, 10)}.png`;
    link.click();
    URL.revokeObjectURL(link.href);
    showToast(quick ? "快捷导出已下载图片" : "图片已导出");
  } catch (error) {
    showToast(`导出失败：${String(error)}`);
  }
}

async function initialize(): Promise<void> {
  try {
    const [loadedSettings, loadedHomework] = await Promise.all([
      readFile<Partial<Settings>>("Settings.json", SETTINGS_KEY),
      readFile<Record<string, HomeworkItem>>("Homework.json", HOMEWORK_KEY),
    ]);
    settings = normalizeSettings(loadedSettings);
    homework = loadedHomework ?? {};
    if (
      loadedSettings === null
      || loadedSettings.Pages?.Basic?.alwaysOnBottom !== true
      || loadedSettings.Pages?.Basic?.contentScale !== settings.Pages.Basic.contentScale
      || (loadedSettings !== null && "opacity" in (loadedSettings.Pages?.Basic ?? {}))
      || loadedSettings?.Pages?.Tags?.items === undefined
    ) {
      await saveSettings();
    }
    if (loadedHomework === null) await saveHomework();
    if (removeExpiredHomeworkPastRetention()) await saveHomework();
    if (viewMode === "editor") {
      editingSubjectId = search.get("subjectId");
      editingExpiredOnly = search.get("expiredOnly") === "true";
      if (!editingSubjectId || !settings.Pages.Subjects.items.some((subject) => subject.Id === editingSubjectId)) {
        throw new Error("打开的作业科目不存在，请从作业板重新打开。");
      }
      editingRecords = Object.values(homework).filter((item) => (
        item.SubjectId === editingSubjectId && isHomeworkExpired(item) === editingExpiredOnly
      ));
      if (editingRecords.length === 0 && editingExpiredOnly) {
        throw new Error("该科目已没有可编辑的过期作业，请关闭此窗口并刷新作业板。");
      }
      root!.innerHTML = renderEditor(true);
      attachBoardEvents();
      document.querySelector<HTMLElement>(".homework-entry")?.focus();
    } else if (viewMode === "settings") {
      renderSettings();
    } else {
      renderBoard();
      await resizeForZoom();
      await applyWindowSettings();
      await listenForPopupUpdates();
    }
  } catch (error) {
    if (root) {
      root.innerHTML = `<main class="load-error"><strong>作业板无法启动</strong><span>${htmlEscape(String(error))}</span><button class="primary-button" onclick="location.reload()">重新加载</button></main>`;
    }
  }
}

async function listenForPopupUpdates(): Promise<void> {
  if (!isTauri()) return;
  try {
    await listen("homework-changed", async () => {
      homework = (await readFile<Record<string, HomeworkItem>>("Homework.json", HOMEWORK_KEY)) ?? {};
      renderBoard();
    });
    await listen("settings-changed", async () => {
      settings = normalizeSettings(await readFile<Partial<Settings>>("Settings.json", SETTINGS_KEY));
      await applyWindowSettings();
      renderBoard();
      await resizeForZoom();
    });
  } catch (error) {
    showToast(`无法同步弹出窗口的更改：${String(error)}`);
  }
}

void initialize();
