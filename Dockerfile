# Sử dụng image Python chính thức
FROM python:3.9-slim

# Đặt thư mục làm việc
WORKDIR /app

# Cài đặt Chrome và ChromeDriver
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-driver \
    && rm -rf /var/lib/apt/lists/*

# Sao chép mã nguồn
COPY . /app

# Cài đặt các thư viện Python
RUN pip install --no-cache-dir -r requirements.txt

# Mở cổng 5001
EXPOSE 5001

# Chạy ứng dụng với Gunicorn
CMD ["gunicorn", "app:app", "--bind", "0.0.0.0:5001", "--timeout", "600"]