import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';

const { PDFDocument, rgb, StandardFonts } = PDFLib;

// ===== State =====
const state = {
  pdfBytes: null,
  pdfDoc: null,
  pdfLibDoc: null,
  currentPage: 1,
  totalPages: 0,
  scale: 1.5,
  tool: 'select',
  annotations: {},
  undoStack: [],
  redoStack: [],
  drawPaths: [],
  isDrawing: false,
  fontSize: 16,
  fontColor: '#000000',
  brushSize: 3,
  brushColor: '#FF0000',
};

// ===== DOM refs =====
const $ = id => document.getElementById(id);
const landing = $('landing');
const editor = $('editor');
const dropZone = $('dropZone');
const fileInput = $('fileInput');
const pdfCanvas = $('pdfCanvas');
const overlayCanvas = $('overlayCanvas');
const pdfCtx = pdfCanvas.getContext('2d');
const olCtx = overlayCanvas.getContext('2d');
const thumbnailList = $('thumbnailList');
const pageInfo = $('pageInfo');
const textOptions = $('textOptions');
const drawOptions = $('drawOptions');

// ===== File loading =====
function setupDropZone() {
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => handleFile(e.target.files[0]));

  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file?.type === 'application/pdf') handleFile(file);
  });
}

async function handleFile(file) {
  if (!file) return;
  $('fileName').textContent = file.name;
  state.pdfBytes = await file.arrayBuffer();

  state.pdfDoc = await pdfjsLib.getDocument({ data: state.pdfBytes.slice(0) }).promise;
  state.totalPages = state.pdfDoc.numPages;
  state.currentPage = 1;

  state.pdfLibDoc = await PDFDocument.load(state.pdfBytes);

  state.annotations = {};
  state.undoStack = [];
  state.redoStack = [];

  showEditor();
  await renderPage(state.currentPage);
  await renderThumbnails();
}

// ===== Navigation =====
function showEditor() {
  landing.classList.add('hidden');
  editor.classList.remove('hidden');
}

function showLanding() {
  editor.classList.add('hidden');
  landing.classList.remove('hidden');
}

// ===== Render =====
async function renderPage(num) {
  const page = await state.pdfDoc.getPage(num);
  const viewport = page.getViewport({ scale: state.scale });

  pdfCanvas.width = viewport.width;
  pdfCanvas.height = viewport.height;
  overlayCanvas.width = viewport.width;
  overlayCanvas.height = viewport.height;

  await page.render({ canvasContext: pdfCtx, viewport }).promise;

  olCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  redrawAnnotations(num);

  pageInfo.textContent = `${num} / ${state.totalPages}`;

  document.querySelectorAll('.thumb-item').forEach((el, i) => {
    el.classList.toggle('active', i + 1 === num);
  });
}

// [FIX #1] 重绘时也要画 text 标注
function redrawAnnotations(pageNum) {
  const annots = state.annotations[pageNum] || [];
  for (const a of annots) {
    if (a.type === 'draw' || a.type === 'highlight') {
      drawPathOnCtx(olCtx, a.data);
    } else if (a.type === 'text') {
      drawTextOnCtx(olCtx, a.data);
    }
  }
}

function drawTextOnCtx(ctx, data) {
  const canvasFontSize = data.fontSize * state.scale;
  ctx.font = `${canvasFontSize}px sans-serif`;
  ctx.fillStyle = data.color;
  ctx.textBaseline = 'top';
  const lines = data.text.split('\n');
  lines.forEach((line, i) => {
    ctx.fillText(line, data.x, data.y + i * canvasFontSize * 1.2);
  });
}

// ===== Thumbnails =====
async function renderThumbnails() {
  thumbnailList.innerHTML = '';
  for (let i = 1; i <= state.totalPages; i++) {
    const page = await state.pdfDoc.getPage(i);
    const vp = page.getViewport({ scale: 0.3 });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width;
    canvas.height = vp.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    const item = document.createElement('div');
    item.className = `thumb-item${i === state.currentPage ? ' active' : ''}`;
    item.appendChild(canvas);

    const label = document.createElement('div');
    label.className = 'thumb-label';
    label.textContent = i;
    item.appendChild(label);

    const actions = document.createElement('div');
    actions.className = 'thumb-actions';
    actions.innerHTML = `
      <button class="thumb-act" data-action="rotate" title="旋转">🔄</button>
      <button class="thumb-act" data-action="delete" title="删除">🗑️</button>
    `;
    item.appendChild(actions);

    item.addEventListener('click', (e) => {
      if (e.target.closest('.thumb-act')) return;
      state.currentPage = i;
      renderPage(i);
    });

    actions.querySelector('[data-action="rotate"]').addEventListener('click', () => rotatePage(i));
    actions.querySelector('[data-action="delete"]').addEventListener('click', () => deletePage(i));

    thumbnailList.appendChild(item);
  }
}

// ===== Page actions =====
async function rotatePage(pageNum) {
  pushUndo();
  const page = state.pdfLibDoc.getPage(pageNum - 1);
  page.setRotation((page.getRotation().angle + 90) % 360);

  const newBytes = await state.pdfLibDoc.save();
  state.pdfBytes = newBytes;
  state.pdfDoc = await pdfjsLib.getDocument({ data: newBytes.slice(0) }).promise;

  await renderPage(state.currentPage);
  await renderThumbnails();
}

async function deletePage(pageNum) {
  if (state.totalPages <= 1) return alert('至少保留一页');
  pushUndo();
  state.pdfLibDoc.removePage(pageNum - 1);
  state.totalPages = state.pdfLibDoc.getPageCount();

  const newAnnots = {};
  for (const [k, v] of Object.entries(state.annotations)) {
    const n = parseInt(k);
    if (n < pageNum) newAnnots[n] = v;
    else if (n > pageNum) newAnnots[n - 1] = v;
  }
  state.annotations = newAnnots;

  const newBytes = await state.pdfLibDoc.save();
  state.pdfBytes = newBytes;
  state.pdfDoc = await pdfjsLib.getDocument({ data: newBytes.slice(0) }).promise;

  if (state.currentPage > state.totalPages) state.currentPage = state.totalPages;
  await renderPage(state.currentPage);
  await renderThumbnails();
}

// ===== Tool switching =====
function setupTools() {
  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.tool = btn.dataset.tool;

      textOptions.classList.toggle('hidden', state.tool !== 'text');
      drawOptions.classList.toggle('hidden', state.tool !== 'draw' && state.tool !== 'highlight' && state.tool !== 'erase');

      overlayCanvas.style.cursor =
        state.tool === 'select' ? 'default' :
        state.tool === 'text' ? 'text' :
        state.tool === 'erase' ? 'cell' : 'crosshair';
    });
  });
}

// ===== Drawing =====
function setupDrawing() {
  overlayCanvas.addEventListener('pointerdown', onPointerDown);
  overlayCanvas.addEventListener('pointermove', onPointerMove);
  overlayCanvas.addEventListener('pointerup', onPointerUp);
  overlayCanvas.addEventListener('pointerleave', onPointerUp);
}

function getCanvasPos(e) {
  const rect = overlayCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (overlayCanvas.width / rect.width),
    y: (e.clientY - rect.top) * (overlayCanvas.height / rect.height),
  };
}

function onPointerDown(e) {
  const pos = getCanvasPos(e);

  if (state.tool === 'text') {
    createTextInput(pos);
    return;
  }

  if (state.tool === 'erase') {
    eraseAt(pos);
    return;
  }

  if (state.tool === 'draw' || state.tool === 'highlight') {
    state.isDrawing = true;
    const firstPt = {
      x: pos.x,
      y: pos.y,
      color: state.tool === 'highlight' ? 'rgba(255,255,0,0.3)' : state.brushColor,
      size: state.tool === 'highlight' ? 16 : state.brushSize,
    };
    state.drawPaths = [firstPt];

    // [FIX #4] 正确初始化画笔路径
    olCtx.beginPath();
    olCtx.moveTo(pos.x, pos.y);
    olCtx.strokeStyle = firstPt.color;
    olCtx.lineWidth = firstPt.size;
    olCtx.lineCap = 'round';
    olCtx.lineJoin = 'round';
    olCtx.globalCompositeOperation = state.tool === 'highlight' ? 'multiply' : 'source-over';
  }
}

function onPointerMove(e) {
  if (!state.isDrawing) return;
  const pos = getCanvasPos(e);
  state.drawPaths.push(pos);

  // [FIX #4] 每次 move 重画完整路径，避免重复 stroke 导致越来越粗
  olCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  redrawAnnotations(state.currentPage);

  olCtx.beginPath();
  olCtx.strokeStyle = state.drawPaths[0].color;
  olCtx.lineWidth = state.drawPaths[0].size;
  olCtx.lineCap = 'round';
  olCtx.lineJoin = 'round';
  olCtx.globalCompositeOperation = state.tool === 'highlight' ? 'multiply' : 'source-over';
  olCtx.moveTo(state.drawPaths[0].x, state.drawPaths[0].y);
  for (let i = 1; i < state.drawPaths.length; i++) {
    olCtx.lineTo(state.drawPaths[i].x, state.drawPaths[i].y);
  }
  olCtx.stroke();
}

function onPointerUp() {
  if (!state.isDrawing) return;
  state.isDrawing = false;
  olCtx.globalCompositeOperation = 'source-over';

  if (state.drawPaths.length > 1) {
    pushUndo();
    const page = state.currentPage;
    if (!state.annotations[page]) state.annotations[page] = [];
    state.annotations[page].push({
      type: state.tool === 'highlight' ? 'highlight' : 'draw',
      data: {
        points: [...state.drawPaths],
        color: state.drawPaths[0].color,
        size: state.drawPaths[0].size,
      },
    });
  }
  state.drawPaths = [];
  // Clean redraw
  renderPage(state.currentPage);
}

function drawPathOnCtx(ctx, data) {
  const pts = data.points;
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.strokeStyle = data.color;
  ctx.lineWidth = data.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i].x, pts[i].y);
  }
  ctx.stroke();
}

function eraseAt(pos) {
  const page = state.currentPage;
  const annots = state.annotations[page] || [];
  for (let i = annots.length - 1; i >= 0; i--) {
    const a = annots[i];
    if (a.type === 'draw' || a.type === 'highlight') {
      for (const pt of a.data.points) {
        const dx = pt.x - pos.x, dy = pt.y - pos.y;
        if (Math.sqrt(dx * dx + dy * dy) < 15) {
          pushUndo();
          annots.splice(i, 1);
          renderPage(state.currentPage);
          return;
        }
      }
    }
    if (a.type === 'text') {
      const canvasFontSize = a.data.fontSize * state.scale;
      const dx = a.data.x - pos.x, dy = a.data.y - pos.y;
      if (Math.abs(dx) < 100 && Math.abs(dy) < canvasFontSize) {
        pushUndo();
        annots.splice(i, 1);
        renderPage(state.currentPage);
        return;
      }
    }
  }
}

// ===== Text input =====
function createTextInput(pos) {
  const existing = document.querySelector('.text-input-overlay');
  if (existing) existing.remove();

  const container = $('canvasContainer');
  const rect = overlayCanvas.getBoundingClientRect();
  const scaleX = rect.width / overlayCanvas.width;
  const scaleY = rect.height / overlayCanvas.height;

  const input = document.createElement('textarea');
  input.className = 'text-input-overlay';
  input.style.left = (pos.x * scaleX) + 'px';
  input.style.top = (pos.y * scaleY) + 'px';
  input.style.fontSize = (state.fontSize * state.scale * scaleY / state.scale) + 'px';
  input.style.color = state.fontColor;
  input.rows = 1;
  container.appendChild(input);
  input.focus();

  let cancelled = false;

  // [FIX #7] Escape 时设标记，blur 时检查
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      input.blur();
    }
    if (e.key === 'Escape') {
      cancelled = true;
      input.remove();
    }
  });

  input.addEventListener('blur', () => {
    if (!cancelled) commitText(input, pos);
  });
}

function commitText(input, pos) {
  const text = input.value.trim();
  input.remove();
  if (!text) return;

  pushUndo();
  const page = state.currentPage;
  if (!state.annotations[page]) state.annotations[page] = [];
  state.annotations[page].push({
    type: 'text',
    data: {
      text,
      x: pos.x,
      y: pos.y,
      fontSize: state.fontSize,
      color: state.fontColor,
    },
  });

  // Redraw everything including the new text
  renderPage(state.currentPage);
}

// ===== Merge =====
function setupMerge() {
  $('btnMerge').addEventListener('click', () => $('mergeInput').click());
  $('mergeInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    pushUndo();
    for (const file of files) {
      const bytes = await file.arrayBuffer();
      const srcDoc = await PDFDocument.load(bytes);
      const pages = await state.pdfLibDoc.copyPages(srcDoc, srcDoc.getPageIndices());
      pages.forEach(p => state.pdfLibDoc.addPage(p));
    }

    state.totalPages = state.pdfLibDoc.getPageCount();
    const newBytes = await state.pdfLibDoc.save();
    state.pdfBytes = newBytes;
    state.pdfDoc = await pdfjsLib.getDocument({ data: newBytes.slice(0) }).promise;

    state.currentPage = state.totalPages;
    await renderPage(state.currentPage);
    await renderThumbnails();
    e.target.value = '';
  });
}

// ===== Split =====
function setupSplit() {
  $('btnSplitCancel').addEventListener('click', () => $('splitModal').classList.add('hidden'));
  $('btnSplitConfirm').addEventListener('click', doSplit);
}

function parsePageNumbers(input, max) {
  const nums = new Set();
  const parts = input.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      const [a, b] = trimmed.split('-').map(Number);
      if (isNaN(a) || isNaN(b)) continue;
      for (let i = Math.max(1, a); i <= Math.min(max, b); i++) nums.add(i);
    } else {
      const n = parseInt(trimmed);
      if (n >= 1 && n <= max) nums.add(n);
    }
  }
  return [...nums].sort((a, b) => a - b);
}

async function doSplit() {
  const input = $('splitPages').value;
  const pages = parsePageNumbers(input, state.totalPages);
  if (!pages.length) return alert('请输入有效页码');

  const newDoc = await PDFDocument.create();
  const copiedPages = await state.pdfLibDoc.copyPages(
    state.pdfLibDoc,
    pages.map(p => p - 1)
  );
  copiedPages.forEach(p => newDoc.addPage(p));

  const bytes = await newDoc.save();
  download(bytes, `split_${pages.join('-')}.pdf`);
  $('splitModal').classList.add('hidden');
}

// ===== Export =====
// [FIX #3] 导出时 clone 文档，不修改原文档；导出后清除 annotations
async function exportPDF() {
  if (!state.pdfLibDoc) return;

  // Clone doc so we don't mutate the working copy
  const savedBytes = await state.pdfLibDoc.save();
  const exportDoc = await PDFDocument.load(savedBytes);

  const font = await exportDoc.embedFont(StandardFonts.Helvetica);
  const renderScale = state.scale;

  for (const [pageNum, annots] of Object.entries(state.annotations)) {
    const pgIdx = parseInt(pageNum) - 1;
    if (pgIdx < 0 || pgIdx >= exportDoc.getPageCount()) continue;
    const pg = exportDoc.getPage(pgIdx);
    const pgSize = pg.getSize();

    for (const a of annots) {
      if (a.type === 'text') {
        const pdfX = a.data.x / renderScale;
        const pdfY = pgSize.height - (a.data.y / renderScale) - a.data.fontSize;

        const c = hexToRgb(a.data.color);
        const lines = a.data.text.split('\n');
        lines.forEach((line, i) => {
          pg.drawText(line, {
            x: pdfX,
            y: pdfY - i * a.data.fontSize * 1.2,
            size: a.data.fontSize,
            font,
            color: rgb(c.r / 255, c.g / 255, c.b / 255),
          });
        });
      }
      if (a.type === 'draw' || a.type === 'highlight') {
        const pts = a.data.points;
        if (pts.length < 2) continue;
        // [FIX #5] 正确处理 rgba 颜色
        const c = colorToRgb(a.data.color);
        const color = rgb(c.r / 255, c.g / 255, c.b / 255);
        const opacity = a.type === 'highlight' ? 0.3 : 1;

        for (let i = 1; i < pts.length; i++) {
          pg.drawLine({
            start: { x: pts[i - 1].x / renderScale, y: pgSize.height - pts[i - 1].y / renderScale },
            end: { x: pts[i].x / renderScale, y: pgSize.height - pts[i].y / renderScale },
            thickness: a.data.size / renderScale,
            color,
            opacity,
          });
        }
      }
    }
  }

  const bytes = await exportDoc.save();
  const origName = $('fileName').textContent;
  const exportName = origName.replace(/\.pdf$/i, '') + '_edited.pdf';
  download(bytes, exportName);

  // Clear annotations since they're baked into the exported file
  state.annotations = {};
  state.undoStack = [];
  state.redoStack = [];
}

// [FIX #5] 支持解析 rgba() 和 hex 两种颜色格式
function colorToRgb(colorStr) {
  // Try hex first
  const hex = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(colorStr);
  if (hex) {
    return {
      r: parseInt(hex[1], 16),
      g: parseInt(hex[2], 16),
      b: parseInt(hex[3], 16),
    };
  }
  // Try rgba(r,g,b,a)
  const rgba = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(colorStr);
  if (rgba) {
    return {
      r: parseInt(rgba[1]),
      g: parseInt(rgba[2]),
      b: parseInt(rgba[3]),
    };
  }
  return { r: 0, g: 0, b: 0 };
}

function hexToRgb(hex) {
  return colorToRgb(hex);
}

function download(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ===== Undo / Redo =====
function pushUndo() {
  state.undoStack.push({
    annotations: JSON.parse(JSON.stringify(state.annotations)),
  });
  state.redoStack = [];
  if (state.undoStack.length > 50) state.undoStack.shift();
}

function undo() {
  if (!state.undoStack.length) return;
  state.redoStack.push({
    annotations: JSON.parse(JSON.stringify(state.annotations)),
  });
  const prev = state.undoStack.pop();
  state.annotations = prev.annotations;
  renderPage(state.currentPage);
}

function redo() {
  if (!state.redoStack.length) return;
  state.undoStack.push({
    annotations: JSON.parse(JSON.stringify(state.annotations)),
  });
  const next = state.redoStack.pop();
  state.annotations = next.annotations;
  renderPage(state.currentPage);
}

// ===== Option controls =====
function setupOptions() {
  $('fontSize').addEventListener('input', e => {
    state.fontSize = parseInt(e.target.value);
    $('fontSizeVal').textContent = state.fontSize;
  });
  $('fontColor').addEventListener('input', e => {
    state.fontColor = e.target.value;
  });
  $('brushSize').addEventListener('input', e => {
    state.brushSize = parseInt(e.target.value);
    $('brushSizeVal').textContent = state.brushSize;
  });
  $('brushColor').addEventListener('input', e => {
    state.brushColor = e.target.value;
  });
}

// ===== Keyboard shortcuts =====
function setupKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      exportPDF();
    }
  });
}

// ===== Init =====
function init() {
  setupDropZone();
  setupTools();
  setupDrawing();
  setupMerge();
  setupSplit();
  setupOptions();
  setupKeyboard();

  $('btnHome').addEventListener('click', showLanding);
  $('btnPrev').addEventListener('click', () => {
    if (state.currentPage > 1) {
      state.currentPage--;
      renderPage(state.currentPage);
    }
  });
  $('btnNext').addEventListener('click', () => {
    if (state.currentPage < state.totalPages) {
      state.currentPage++;
      renderPage(state.currentPage);
    }
  });
  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);
  $('btnSplit').addEventListener('click', () => $('splitModal').classList.remove('hidden'));
  $('btnExport').addEventListener('click', exportPDF);
}

init();
