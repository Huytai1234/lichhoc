# Sử dụng base image Python phiên bản 3.11 (chọn phiên bản slim để nhẹ hơn)
FROM python:3.11-slim

# Thiết lập thư mục làm việc bên trong container
WORKDIR /app

# Thiết lập biến môi trường cho Python (ngăn tạo file .pyc, chạy unbuffered)
ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1

# Copy file requirements trước để tận dụng Docker cache nếu file này không đổi
COPY requirements.txt .

# Cài đặt các thư viện Python
# --no-cache-dir để không lưu cache pip, giữ image nhỏ
# --default-timeout=100 tăng thời gian chờ pip phòng mạng chậm
RUN pip install --no-cache-dir --default-timeout=100 -r requirements.txt

# Copy toàn bộ mã nguồn ứng dụng vào thư mục làm việc /app
COPY . .

# Thiết lập biến môi trường PORT mà Cloud Run mong đợi (thường là 8080)
ENV PORT 8080

# Chỉ định cổng mà container sẽ lắng nghe khi chạy
EXPOSE 8080

# Lệnh để chạy ứng dụng khi container khởi động
# Sử dụng Gunicorn, bind vào cổng $PORT mà Cloud Run cung cấp
# --workers=4: Số lượng worker (có thể điều chỉnh)
# --timeout 120: Tăng thời gian chờ của worker lên 120s (phòng trường hợp request xử lý lâu)
CMD ["gunicorn", "--workers=4", "--bind", "0.0.0.0:8080", "--timeout", "120", "app:app"]