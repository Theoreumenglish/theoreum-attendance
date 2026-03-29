import './style.css';
import { callGAS } from '../api/rpc.js';

// --- 유틸리티 ---
const $ = (sel, root = document) => root.querySelector(sel);

const App = {
    sess: localStorage.getItem('ATT_SESS') || '',
    currentView: localStorage.getItem('ATT_LAST_VIEW') || 'kiosk',
    
    // 🔥 [수정] 기존 google.script.run 대신 Vercel rpc.js를 사용합니다.
    async rpc(op, args = {}) {
        UI.busy(true);
        try {
            const res = await callGAS({ op, args, sessionToken: App.sess });
            return res;
        } catch (err) {
            return { ok: false, error: { message: '통신 오류가 발생했습니다.' } };
        } finally {
            UI.busy(false);
        }
    },

    // 원장님의 기존 App.init() 로직...
    async init() {
        this.startClock();
        Router.bindTopbar();
        if (this.currentView === 'staff') await Router.goStaff();
        else await Router.goKiosk();
    },

    startClock() {
        setInterval(() => {
            const now = new Date();
            if ($('#ssTime')) $('#ssTime').textContent = now.getHours().toString().padStart(2, '0') + ":" + now.getMinutes().toString().padStart(2, '0');
        }, 1000);
    }
};

// --- 원장님 코드의 UI, Router, Kiosk 객체들을 이 아래에 쭉 붙여넣으세요 ---
// (단, google.script.run 호출부는 모두 App.rpc()로 대체되어야 합니다.)

const UI = {
    busy(on) { $('#busyBar')?.classList.toggle('on', !!on); },
    render(tplId) {
        const tpl = document.getElementById(tplId);
        const v = $('#viewPort');
        v.innerHTML = '';
        v.appendChild(tpl.content.cloneNode(true));
    },
    // ... 나머지 UI 메서드들
};

const Router = {
    bindTopbar() {
        $('#navKiosk').onclick = () => this.goKiosk();
        $('#navStaff').onclick = () => this.goStaff();
    },
    async goKiosk() {
        App.currentView = 'kiosk';
        UI.render('tpl-kiosk');
        // Kiosk.init() 호출 등...
    },
    // ... 나머지 Router 메서드들
};

// 앱 구동 시작
window.onload = () => App.init();