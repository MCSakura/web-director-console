FROM python:3.11-slim

WORKDIR /app

# 只依赖 websockets，其余全部用标准库
RUN pip install --no-cache-dir websockets==12.0

COPY gateway.py /app/gateway.py

ENV TZ=Asia/Shanghai \
    DANMAKU_HOST=0.0.0.0 \
    DANMAKU_PORT=8099

EXPOSE 8099

CMD ["python", "-u", "gateway.py"]
