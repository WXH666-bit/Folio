FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash ripgrep poppler-utils && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir PyMuPDF==1.26.4 python-docx==1.2.0 openpyxl==3.1.5 python-pptx==1.0.2 beautifulsoup4==4.14.2
WORKDIR /workspace
CMD ["sleep", "infinity"]
