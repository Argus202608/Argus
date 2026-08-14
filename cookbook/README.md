# Argus Cookbook：一个会看、会听、会想、会说的多模态 Agent

> 一本记录"看、听、想、说"四层架构的工程叙事。

这是 Argus（基于 Hermes 的多模态实时视频 Agent）多模态子系统的**设计手册**。它不讲怎么装、怎么配（那看项目根 [README](../README.md)），而是讲**这套"边看边聊"的系统在架构和技术细节上是怎么想的、为什么这么做、如果不这么做会怎样**。

全书围绕四个能力层展开——**看、听、想、说**——外加一章贯穿全局的工程经验。每一章都尽量做到：先讲清**为什么**，再落到**代码在哪、怎么写的**（引用均为 `文件:行号`，可点击跳转）。书里每一条设计原则、每一个"踩过的坑"，都来自项目真实的对话、日志与用户反馈。

## 目录

| 章节 | 主题 | 一句话 |
| --- | --- | --- |
| [序章](00-序章-一个会看会听会想会说的Agent.md) | 全景与分层哲学 | 为什么把系统拆成"看/听/想/说"四层，一帧画面的一生 |
| [第 1 章 · 看](01-看-让Agent拥有眼睛.md) | 视觉感知 | FrameBuffer、dHash 入口去重、场景动态阈值、QueryWorker 提问时刻帧、watcher TTL+帧数双门 |
| [第 2 章 · 听](02-听-让Agent拥有耳朵.md) | 语音输入 | 流式 ASR 协议、死 socket 自愈、本地意图模型、barge-in、音视频时间基对齐 |
| [第 3 章 · 想](03-想-让Agent拥有大脑.md) | 推理与记忆 | 三层记忆、ReAct 深研、事件监控 hook 主 Agent、系统提示编排、空图 400 |
| [第 4 章 · 说](04-说-让Agent开口说话.md) | 语音输出 | VoiceAgent、`_flush_to_tts` 唯一门、per-segment TTS、真打断、温暖化 |
| [第 5 章 · 工程经验](05-贯穿全局的工程经验.md) | 贯穿全局 | 长会话性能、前后端状态一致性、配置架构、评测体系、九条设计原则 |

## 建议读法

- **想快速建立全局认知**：读[序章](00-序章-一个会看会听会想会说的Agent.md)，尤其是那张"一帧的一生"数据流图。
- **按能力深入**：四个核心章节可独立阅读，但建议先读[序章](00-序章-一个会看会听会想会说的Agent.md) + [第 1 章](01-看-让Agent拥有眼睛.md)，因为 `FrameBuffer` 这个共享地基后面每章都会用到。
- **只关心踩坑与设计品味**：直接读[第 5 章](05-贯穿全局的工程经验.md)。

## 一句话架构

主 Agent 只处理**用户文本与语义路由**，不被动收到直播帧。当前、历史和“画面实体 + 外部事实”的一次性问题统一调 `query_multimodal` 交给 QueryWorker；它读取提问时刻帧，再按需使用 Recall/Search。`get_current_frame` 只用于显式取回/展示/诊断最新原始帧；Watcher 和 Monitor 分别负责持续深研与事件监控。这些角色共享同一份 `FrameBuffer` + `MemoryStore`，形成“一份感知、多方消费”的地基。

## 技术栈速查

```
后端          Python · asyncio · DashScope Realtime ASR/TTS
前端 (web)    React · Vite · Tailwind
前端 (desktop) Electron · nanostores · assistant-ui
协议          WebSocket (gateway) · JSON-RPC (tools) · PCM16 (audio)
AI            qwen3-asr-flash-realtime · qwen3-tts-flash-realtime · deepseek-v4-flash
             + 主路由模型 + 支持视觉的 QueryWorker/记忆/监控/深研模型（config 可独立配）
```

---

*最后更新：2026 年 7 月*
