import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import "./styles/global.css";
import "@xterm/xterm/css/xterm.css";

// 注意：不使用 StrictMode。xterm 终端为有副作用的组件，
// StrictMode 开发模式下会双挂载并并发发起 SSH 连接，导致首次连接失败需重试。
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
