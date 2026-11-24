import { scenario } from './data/scenario.js';
import { initApp } from './ui/app.js';

// 初始种子固定，便于复现讨论；"新对局"按钮随机换种子。
// window.game 暴露对局状态读取器，供调试与联机开发使用。
window.game = initApp(document.getElementById('map'), scenario, 20261124);
