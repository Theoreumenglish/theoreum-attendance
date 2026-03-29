/**
 * [The Oreum Attendance System - Refactored Logic]
 * 기존 GAS 로직을 Vite + Vercel 환경으로 이식한 엔진입니다.
 */
import '../style.css';
import { callGAS } from '../api/rpc.js';

// --- 1. 전역 상수 및 유틸리티 ---
const $ = (sel, root = document) => root.querySelector(sel);

const App = {
  sess: localStorage.getItem('ATT_SESS') || '',
  currentView: localStorage.getItem('ATT_LAST_VIEW') || 'kiosk',
  
  // 핵심: 기존의 google.script.run 대신 이 rpc 함수를 사용합니다.
  async rpc(op, args = {}) {
    const response = await callGAS({ op, args, sessionToken: App.sess });
    return response;
  },

  async init() {
    // 초기 화면 설정
    if (this.currentView === 'staff') this.goStaff();
    else this.goKiosk();
    
    this.startClock(); // 시계 가동
  },

  startClock() {
    setInterval(() => {
      const now = new Date();
      // 원장님 코드의 시계 로직 반영
      const elTime = $('#ssTime');
      if (elTime) elTime.textContent = now.getHours().toString().padStart(2, '0') + ":" + now.getMinutes().toString().padStart(2, '0');
    }, 1000);
  },

  goKiosk() {
    this.currentView = 'kiosk';
    this.render('tpl-kiosk');
    // 여기서부터 원장님의 Kiosk.init() 로직을 연결하면 됩니다.
  },

  render(tplId) {
    const tpl = document.getElementById(tplId);
    const v = $('#app');
    v.innerHTML = '';
    v.appendChild(tpl.content.cloneNode(true));
  }
};

// 앱 구동
App.init();