FROM python:3.12-slim
RUN pip install --no-cache-dir 'fastapi>=0.115,<1' 'uvicorn[standard]>=0.34,<1' 'httpx>=0.28,<1' 'pyjwt>=2.10,<3' 'cryptography>=44,<46'
COPY main.py /app/main.py
EXPOSE 4000
CMD ["python", "/app/main.py"]
