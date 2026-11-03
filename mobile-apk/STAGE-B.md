# 阶段 B：QQ + NapCat 进包（当前实现说明）

## 入口
BridgeService.setupContainer() 探针出现 CONTAINER_OK → containerReady=true → 起 
ew StageB(ctx, base).run()
**容器没通过时绝不会执行阶段 B**（这是刻意的：让用户一眼看出卡在容器还是 QQ）。

## 首启流程（屏幕上依次出现）
1. 解压容器组件… → proot 已就位
2. 解压 Ubuntu rootfs… → 
ootfs 解压完成
3. 容器探针… → 容器可用（CONTAINER_OK）
4. [B] 准备 QQ 与 NapCat
5. 下载 QQ 客户端 x%（约 **198 MB**，实测 Content-Length 207,538,924）
6. 下载 NapCat x%（约 34 MB）
7. 安装 QQ（apt，首次 3~8 分钟）… → [1/4] apt update … INSTALL_DONE
8. 启动 QQ（第一次会初始化，稍等）… → QQ_STARTED
9. 等待扫码（二维码已就绪） + 二维码图显示在屏幕上

## 关键常量
- URL：QQ linuxqq_3.2.34-53644_arm64.deb（qqdl.gtimg.cn）；NapCat 
eleases/latest/download/NapCat.Shell.zip
- OneBot：127.0.0.1:6199（ws，token qb-token-2026）/ 6198（http）
- 首次运行写 iles/app/config.json：gateway.provider=napcat、gent.mode=local

## 已知限制
- 模拟器（x86_64）上 arm64 proot 会 **Segmentation fault**，容器阶段必然失败 → 阶段 B 不会启动（这正是设计意图，不是 bug）
- APK 未打 debuggable，db run-as 看不了私有目录
