/**
 * [The Oreum Attendance System - Main Logic]
 * 최우선 순위: 퀄리티, 안정성, 실시간 디버깅 검토
 */

// [수정 후 - Case 2: 경로를 가장 확실하게 찾는 절대 경로 방식]
import { callGAS } from '/api/rpc.js';

// --- 1. 유틸리티 및 전역 상태 관리 ---
const $ = (target) => document.querySelector(target);
let state = {
  currentTab: 'student', // 'student' | 'staff'
  inputBuffer: '',
  isProcessing: false
};

// --- 2. 초기 UI 렌더링 (Boilerplate 제거 및 Kiosk UI 생성) ---
function initApp() {
  const app = $('#app');
  app.innerHTML = `
    <div class="kiosk-container">
      <header>
        <h1 class="logo">THE OREUM</h1>
        <div class="tab-menu">
          <button id="btn-tab-student" class="tab-btn active">학생 출결</button>
          <button id="btn-tab-staff" class="tab-btn">직원 전용</button>
        </div>
      </header>

      <main id="main-content">
        <section class="display-section">
          <div class="status-indicator" id="status-text">입력 대기 중...</div>
          <div class="input-display" id="input-display">----</div>
        </section>

        <section class="keypad">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 'C', 0, '←'].map(key => 
            `<button class="key-btn" data-key="${key}">${key}</button>`
          ).join('')}
        </section>

        <section class="action-buttons">
          <button id="btn-check-in" class="action-btn check-in">등원</button>
          <button id="btn-check-out" class="action-btn check-out">하원</button>
        </section>
      </main>

      <div id="debug-panel" class="debug-panel"></div>
    </div>
  `;

  bindEvents();
  logDebug('System Initialized: All modules loaded.');
}

// --- 3. 이벤트 바인딩 ---
function bindEvents() {
  // 키패드 클릭
  $('.keypad').addEventListener('click', (e) => {
    if (!e.target.classList.contains('key-btn')) return;
    handleKeypad(e.target.dataset.key);
  });

  // 탭 전환
  $('#btn-tab-student').onclick = () => switchTab('student');
  $('#btn-tab-staff').onclick = () => switchTab('staff');

  // 출결 버튼
  $('#btn-check-in').onclick = () => handleAttendance('등원');
  $('#btn-check-out').onclick = () => handleAttendance('하원');

  // 실시간 키보드 입력 지원 (물리 키보드/QR 스캐너용)
  window.onkeydown = (e) => {
    if (e.key >= '0' && e.key <= '9') handleKeypad(e.key);
    if (e.key === 'Backspace') handleKeypad('←');
    if (e.key === 'Escape') handleKeypad('C');
    if (e.key === 'Enter') handleAttendance('등원');
  };
}

// --- 4. 비즈니스 로직 ---
function handleKeypad(key) {
  if (state.isProcessing) return;

  if (key === 'C') {
    state.inputBuffer = '';
  } else if (key === '←') {
    state.inputBuffer = state.inputBuffer.slice(0, -1);
  } else if (state.inputBuffer.length < 8) {
    state.inputBuffer += key;
  }

  updateDisplay();
}

function updateDisplay() {
  const display = $('#input-display');
  display.innerText = state.inputBuffer || '----';
  
  if (state.inputBuffer.length > 0) {
    display.classList.add('typing');
  } else {
    display.classList.remove('typing');
  }
}

async function handleAttendance(type) {
  if (state.isProcessing || !state.inputBuffer) return;

  const id = state.inputBuffer;
  setProcessing(true, `${id}님 ${type} 처리 중...`);

  try {
    logDebug(`Requesting API: action=attendance, id=${id}, type=${type}`);
    
    // api/rpc.js를 통해 구글 시트와 통신
    const response = await callGAS({
      action: 'attendance',
      id: id,
      type: type,
      timestamp: new Date().toISOString()
    });

    if (response.success) {
      showResult('SUCCESS', `${response.name}님 ${type} 완료!`, 'green');
      state.inputBuffer = '';
    } else {
      showResult('ERROR', response.message || '등록되지 않은 번호입니다.', 'red');
    }
  } catch (err) {
    logDebug(`Critical Error: ${err.message}`);
    showResult('NETWORK ERROR', '서버 연결 실패. 다시 시도해 주세요.', 'orange');
  } finally {
    setProcessing(false);
    updateDisplay();
  }
}

function switchTab(tab) {
  state.currentTab = tab;
  $('.tab-btn.active').classList.remove('active');
  $(`#btn-tab-${tab}`).classList.add('active');
  
  if (tab === 'staff') {
    $('#main-content').innerHTML = `
      <div class="staff-login">
        <h3>관리자 로그인</h3>
        <input type="password" id="staff-pw" placeholder="비밀번호 입력">
        <button id="btn-staff-login" class="action-btn">접속</button>
      </div>
    `;
  } else {
    // 학생 탭으로 복귀 시 UI 재생성 (단순화를 위해 재호출)
    initApp();
  }
}

// --- 5. 디버깅 및 UI 상태 제어 ---
function setProcessing(loading, message) {
  state.isProcessing = loading;
  $('#status-text').innerText = message || (loading ? '처리 중...' : '입력 대기 중...');
  if (loading) {
    $('.action-buttons').style.opacity = '0.5';
    $('.action-buttons').style.pointerEvents = 'none';
  } else {
    $('.action-buttons').style.opacity = '1';
    $('.action-buttons').style.pointerEvents = 'auto';
  }
}

function showResult(title, msg, color) {
  const statusText = $('#status-text');
  statusText.style.color = color;
  statusText.innerText = `[${title}] ${msg}`;
  
  setTimeout(() => {
    statusText.style.color = '';
    statusText.innerText = '입력 대기 중...';
  }, 3000);
}

function logDebug(msg) {
  const panel = $('#debug-panel');
  if (panel) {
    const time = new Date().toLocaleTimeString();
    panel.innerHTML = `<div>[${time}] ${msg}</div>` + panel.innerHTML;
    console.log(`[DEBUG] ${msg}`);
  }
}

// 구동 시작
initApp();