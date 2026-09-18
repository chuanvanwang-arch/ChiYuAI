# 模型权重说明

bge-large-zh-v1.5：https://huggingface.co/BAAI/bge-large-zh-v1.5

转换：transformers → ONNX（`optimum-cli export onnx --task feature-extraction`）。

本镜像内嵌 ONNX；现场可挂载 `/models` 覆盖（换权重或升级地址增强）。
无权重时 `InferBackend` 自动降级哈希签名（384 维），链路不中断。
