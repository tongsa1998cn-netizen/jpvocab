// 云同步（Firebase）：登录后把学习进度、设置、导入的单词、学习记录同步到云端。
// 数据放在 users/{uid}/ 下：progress/0..15 每个分片存一部分词的进度（JSON 字符串），meta/main 存设置等。
// 合并规则：每个词以修改时间 t 新的为准；设置同理；导入的单词取并集；学习记录按设备分开存、统计时相加。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, getDoc, runTransaction } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCRjiwCvFnjIYaNqBGKXl7TUIUndMxH-rQ',
  authDomain: 'moji-words.firebaseapp.com',
  projectId: 'moji-words',
  storageBucket: 'moji-words.firebasestorage.app',
  messagingSenderId: '1011416125315',
  appId: '1:1011416125315:web:a78c8f10376aa13d4130b6'
};
const SHARDS = 16;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const APP = window.APP;

let user = null;
let known = {};          // 分片号 / 'meta' → 最近一次和云端一致时的内容，用来判断有没有要上传的
let timer = null, running = false, again = false;
let status = { kind: '', text: '' }, lastOk = 0;

const shardOf = id => { let h = 0; for (const c of id) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % SHARDS; };
const sorted = o => JSON.stringify(Object.keys(o).sort().reduce((a, k) => (a[k] = o[k], a), {}));
const shardRef = k => doc(db, 'users', user.uid, 'progress', String(k));
const metaRef = () => doc(db, 'users', user.uid, 'meta', 'main');

function localShards() {
  const P = APP.state.progress, out = Array.from({ length: SHARDS }, () => ({}));
  for (const id in P) out[shardOf(id)][id] = P[id];
  return out;
}
// 两边合并：同一个词取修改时间新的；一样新时用本地的
function mergeMaps(remote, local) {
  const out = { ...remote };
  for (const id in local) if (!out[id] || (local[id].t || 0) >= (out[id].t || 0)) out[id] = local[id];
  return out;
}
function localMeta() {
  const s = APP.state;
  return { settings: JSON.stringify(s.settings), settingsT: s.settingsT || 0, custom: JSON.stringify(s.custom), log: JSON.stringify(s.log) };
}

/* ---------- 拉取：打开 App、登录、切回前台时 ---------- */
async function pull() {
  const snaps = await Promise.all([...Array(SHARDS).keys()].map(k => getDoc(shardRef(k))));
  const remote = {};
  snaps.forEach((s, k) => {
    const m = s.exists() ? JSON.parse(s.data().json) : {};
    known[k] = sorted(m);
    Object.assign(remote, m);
  });
  APP.applyRemoteProgress(remote);
  const ms = await getDoc(metaRef());
  if (ms.exists()) APP.applyRemoteMeta(ms.data());
}

/* ---------- 上传：本地有改动的分片，用事务和云端合并后写回 ---------- */
async function push() {
  const shards = localShards();
  for (let k = 0; k < SHARDS; k++) {
    if (sorted(shards[k]) === known[k]) continue;
    const merged = await runTransaction(db, async tx => {
      const s = await tx.get(shardRef(k));
      const m = mergeMaps(s.exists() ? JSON.parse(s.data().json) : {}, shards[k]);
      tx.set(shardRef(k), { json: sorted(m), t: Date.now() });
      return m;
    });
    known[k] = sorted(merged);
    APP.applyRemoteProgress(merged);   // 事务里读到别的设备更新的词，顺便合并到本地
  }
  const lm = localMeta(), lj = JSON.stringify(lm);
  if (lj !== known.meta) {
    const remote = await runTransaction(db, async tx => {
      const s = await tx.get(metaRef());
      const r = s.exists() ? s.data() : {};
      const custom = JSON.parse(r.custom || '[]');
      const idOf = a => a[0] + '|' + (a[1] || a[0]).replace(/\[[^\]]*\]/g, '');
      const have = new Set(custom.map(idOf));
      for (const a of JSON.parse(lm.custom)) if (!have.has(idOf(a))) { custom.push(a); have.add(idOf(a)); }
      const newer = lm.settingsT >= (r.settingsT || 0);
      const out = {
        settings: newer ? lm.settings : r.settings, settingsT: newer ? lm.settingsT : r.settingsT,
        custom: JSON.stringify(custom), logs: { ...(r.logs || {}), [APP.DEV]: lm.log }
      };
      tx.set(metaRef(), out);
      return out;
    });
    APP.applyRemoteMeta(remote);
    known.meta = JSON.stringify(localMeta());
  }
}

/* ---------- 调度：同一时间只跑一个；失败了下次有改动或联网时再试 ---------- */
async function run(withPull) {
  if (!user) return;
  if (running) { again = true; return; }
  running = true; setStatus('busy', '正在同步…');
  try {
    if (withPull) await pull();
    await push();
    lastOk = Date.now(); setStatus('ok', '已同步');
  } catch (e) {
    console.warn('sync failed', e);
    setStatus('err', navigator.onLine === false ? '离线中，联网后会自动同步' : '同步失败：' + (e.code || e.message));
  } finally {
    running = false;
    if (again) { again = false; run(false); }
  }
}
window.onLocalSave = () => { if (!user) return; clearTimeout(timer); timer = setTimeout(() => run(false), 1500); };
document.addEventListener('visibilitychange', () => { if (!user) return; document.hidden ? (clearTimeout(timer), run(false)) : run(true); });
window.addEventListener('online', () => run(true));

/* ---------- 设置页的“云同步”面板 ---------- */
const panel = document.getElementById('syncPanel');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let showEmail = false;

function setStatus(kind, text) { status = { kind, text }; render(); }
function render() {
  if (!panel) return;
  if (user) {
    const t = lastOk ? new Date(lastOk).toLocaleTimeString().slice(0, 5) : '';
    panel.innerHTML = `<h3>云同步</h3>
      <p class="note"><span class="syncdot ${status.kind === 'ok' ? 'ok' : status.kind === 'busy' ? 'busy' : status.kind === 'err' ? 'err' : ''}"></span>${esc(status.text || '已登录')}${status.kind === 'ok' && t ? `（${t}）` : ''}<br>
        账号：${esc(user.email || user.displayName || user.uid)}<br>在其他设备上登录同一个账号，学习进度会自动合并。</p>
      <div class="btnrow"><button class="btn primary" id="syncNow">立即同步</button><button class="btn" id="syncOut">退出登录</button></div>`;
    panel.querySelector('#syncNow').onclick = () => run(true);
    panel.querySelector('#syncOut').onclick = async () => { if (confirm('退出后这台设备不再同步（本地进度保留）。确定吗？')) await signOut(auth); };
    return;
  }
  panel.innerHTML = `<h3>云同步</h3>
    <p class="note">未登录：进度只保存在这台设备上。登录后，手机和电脑的进度会自动同步。${status.kind === 'err' ? `<br><b style="color:var(--red)">${esc(status.text)}</b>` : ''}</p>
    <div class="btnrow"><button class="btn primary" id="syncGoogle">用谷歌账号登录</button><button class="btn" id="syncEmailToggle">用邮箱登录</button></div>
    ${showEmail ? `<div class="syncform"><input id="syncEmail" type="email" placeholder="邮箱" autocomplete="username">
      <input id="syncPass" type="password" placeholder="密码（至少 6 位）" autocomplete="current-password">
      <div class="btnrow" style="margin-top:0"><button class="btn primary" id="syncLogin">登录</button><button class="btn" id="syncSignup">注册新账号</button></div></div>` : ''}`;
  panel.querySelector('#syncGoogle').onclick = async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (e) { setStatus('err', authMsg(e)); }
  };
  panel.querySelector('#syncEmailToggle').onclick = () => { showEmail = !showEmail; render(); };
  if (showEmail) {
    const go = fn => async () => {
      const email = panel.querySelector('#syncEmail').value.trim(), pass = panel.querySelector('#syncPass').value;
      try { await fn(auth, email, pass); } catch (e) { setStatus('err', authMsg(e)); }
    };
    panel.querySelector('#syncLogin').onclick = go(signInWithEmailAndPassword);
    panel.querySelector('#syncSignup').onclick = go(createUserWithEmailAndPassword);
  }
}
function authMsg(e) {
  const m = {
    'auth/popup-blocked': '弹出窗口被拦截了，请允许弹窗，或改用邮箱登录',
    'auth/popup-closed-by-user': '登录窗口被关掉了',
    'auth/operation-not-supported-in-this-environment': '这里不支持谷歌登录弹窗，请改用邮箱登录',
    'auth/unauthorized-domain': '这个网址还没加到 Firebase 的“已获授权的网域”里',
    'auth/operation-not-allowed': '这种登录方式还没在 Firebase 里开启',
    'auth/invalid-credential': '邮箱或密码不对', 'auth/wrong-password': '邮箱或密码不对', 'auth/user-not-found': '这个邮箱还没注册',
    'auth/email-already-in-use': '这个邮箱已经注册过了，请直接登录', 'auth/weak-password': '密码至少 6 位',
    'auth/invalid-email': '邮箱格式不对', 'auth/network-request-failed': '网络连接失败'
  };
  return m[e.code] || ('登录失败：' + (e.code || e.message));
}

onAuthStateChanged(auth, u => {
  user = u; known = {};
  status = u ? { kind: 'busy', text: '正在同步…' } : { kind: '', text: '' };
  render();
  if (u) { APP.toast('已登录，正在同步学习进度'); run(true); }
});
render();
