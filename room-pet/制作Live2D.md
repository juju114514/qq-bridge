# 用 Live2D 制作图鲸鲸（当前进度 + 怎么继续）

## 一、现状：分层已经做好了

`make_layers.py` 从现有帧里拆出了 L2D 需要的图层，产物在 `assets/`：

```
assets/tujingjing.psd        1254×1254，8 个图层，可直接拖进 Cubism Editor
assets/layers/face.png       脸底图（眼睛和嘴已挖掉并 inpaint 补好）
assets/layers/eye1_open.png  左眼·睁
assets/layers/eye1_closed.png 左眼·闭（来自 blink 帧）
assets/layers/eye2_open.png  右眼·睁
assets/layers/eye2_closed.png 右眼·闭
assets/layers/mouth_closed.png 嘴·闭
assets/layers/mouth_open.png   嘴·张（来自 crying 帧）
assets/layers/preview_closed.png 合图预览（确认没穿帮）
```

**验证：** `preview_closed.png` 是「脸底图 + 闭眼层」的合成图，接缝不可见；PSD 合成后是完整立绘。

## 二、还差什么：Cubism Editor 里绑定

Cubism Editor 的下载需要**人工在官网勾选协议 + 过人机验证**，脚本拿不到直链：

```
https://www.live2d.com/en/cubism/download/editor/
```

下载安装后（FREE 版够用），按下面做：

### 1. 导入

```
File → Open → 选 assets/tujingjing.psd
```

### 2. 加参数（关键就三个）

| 参数 ID | 范围 | 绑定图层 |
| --- | --- | --- |
| `ParamEyeLOpen` / `ParamEyeROpen` | 0~1 | 0 显示 closed，1 显示 open（用「不透明度」关键帧） |
| `ParamMouthOpenY` | 0~1 | 0 显示 mouth_closed，1 显示 mouth_open |
| `ParamAngleX` | -30~30 | 整个角色图层做 ±10px 横移（用「弯曲变形器」） |

### 3. 加变形器

```
选中 face + eye + mouth 图层 → 右键 → 新建弯曲变形器
给 ParamAngleX 打两个关键帧：-30 时网格整体左移 10px，+30 时右移 10px
```

### 4. 眨眼

```
在 Timeline 里给 ParamEyeOpen 做一个 0.12 秒的闭眼曲线，设成 Idle 动作循环
```

### 5. 导出

```
File → Export → 导出 model3.json + moc3 + 贴图
把整个文件夹放到 room-pet/models/tujingjing/
改 l2d.js 里的 MODEL_URL = 'models/tujingjing/tujingjing.model3.json'
```

## 三、没有 Cubism 时也能先看效果

`l2d-layers.html` 用同一套分层在网页里跑同样的三个参数（眨眼/张嘴/转头），
不用装任何东西就能确认分层对不对：

```
http://127.0.0.1:8796/l2d-layers.html
```

## 四、这套分层的边界（重要）

| 有 | 没有 |
| --- | --- |
| 睁/闭眼、嘴开/合、整头转动 | 发丝独立摆动 |
| 表情（可另做 annoyed/crying 的嘴眼贴片） | 眉毛独立运动（现在画在脸底图上） |

**原因：原始素材是整图，眉眼嘴都画在一起；眼睛/嘴能拆是因为有 blink 和 crying 两个帧可以做差分，头发没有第二帧可拆。**

要完整 L2D（发丝、眉毛、身体起伏），还是得**分层立绘**——那需要画师把原画拆成几十层，或者拿到原始 PSD。
