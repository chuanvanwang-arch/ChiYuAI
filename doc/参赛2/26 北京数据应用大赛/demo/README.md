# chiyu-group 群诉智能发现 DEMO

基于多维语义相似度的群体性诉求智能发现：L0 数据接入（清洗）→ L1 四维特征（文本/地址/实体/时间，多通道降级链）→ L2 双轨记忆体（日志轨仅追加 + 笔记轨幂等重写 + 簇生命周期状态机）→ L3 混合裁决（8 确定性评分 + 1 软评分可关 + RRF(K=60) 融合 + 红线优先）→ L4 闭环回流。

**部署：** 本地裸 Python 验证（无 Docker）→ 竞赛环境现场 docker build（三变体）。
**评测：** `python -m chiyu_group.main --evaluate` → `output/eval_report`
**容器：** `docker build -f docker/Dockerfile.base|cuda|ascend -t chiyu-group:<tag> .`
**数据：** `data/sample`（样例内置）· `data/real`（真实挂载覆盖）· `data/uploaded`（上传）
**权重：** `models/bge-large-zh-v1.5.onnx`（内嵌或卷覆盖；缺失时哈希降级）

## 本地运行

```bash
# 1. 安装依赖（CPU 推理）
pip install -r requirements-common.txt -r requirements-cpu.txt
pip install -e .

# 2. 启动服务（端口 8080）
uvicorn chiyu_group.serving.api:app --host 0.0.0.0 --port 8080

# 3. 打开 7 页看板
# http://localhost:8080/          （P1 总览）
# http://localhost:8080/replay    （P2 流式回放）
# http://localhost:8080/cluster   （P3 簇视图）
# http://localhost:8080/merge     （P4 跨日合并时间轴）
# http://localhost:8080/audit     （P5 可解释裁决）
# http://localhost:8080/evaluation（P6 评测）
# http://localhost:8080/settings  （P7 数据三通道/参数）
```

## 评测

```bash
python -m chiyu_group.main --evaluate --dataset sample
# 输出：output/eval_report.json + output/eval_report.md
# 指标：宏平均 F1 / 跨日合并准确率 / 最小成诉敏感度 / 单条耗时 P50·P95
```

## 容器构建

```bash
# CPU / 信创一（无 GPU）
docker build -f docker/Dockerfile.base -t chiyu-group:base .

# 非信创二（A100）
docker build -f docker/Dockerfile.cuda -t chiyu-group:cuda .
docker run --gpus all -p 8080:8080 chiyu-group:cuda

# 信创二（昇腾 910B）
docker build -f docker/Dockerfile.ascend -t chiyu-group:ascend .

# 或直接 compose（三 profile）
docker compose --profile base up
docker compose --profile cuda up
docker compose --profile ascend up
```

推理后端自动探测：`INFER_BACKEND=auto|cpu|cuda|ascend|none`，模型缺失时自动降级到确定性哈希签名（384 维），链路不中断。

## 数据三通道

| 通道 | 路径 | 说明 |
|------|------|------|
| 内置样例 | `data/sample/sample.csv` | 43 条官方样例 |
| 真实挂载 | `data/real/` | 脱敏 1 万条，卷覆盖 |
| 上传 | `data/uploaded/` | API `/api/upload` 落盘 |
