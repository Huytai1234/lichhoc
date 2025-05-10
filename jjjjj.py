import os

def read_code_files_to_txt(source_directory, output_file_path):
    """
    Đọc tất cả các tệp mã trong thư mục nguồn và các thư mục con của nó,
    bỏ qua các tệp .png, sau đó ghi nội dung của chúng vào một tệp TXT duy nhất
    và đếm số lượng tệp mã đã xử lý.

    Args:
        source_directory (str): Đường dẫn đến thư mục chứa các tệp mã.
        output_file_path (str): Đường dẫn đến tệp TXT đầu ra.
    """
    code_file_count = 0  # Khởi tạo biến đếm tệp mã
    try:
        with open(output_file_path, 'w', encoding='utf-8') as outfile:
            for root, _, files in os.walk(source_directory):
                for filename in files:
                    # Kiểm tra nếu tệp có đuôi .png thì bỏ qua
                    if filename.lower().endswith(".png"):
                        print(f"Bỏ qua tệp hình ảnh: {os.path.join(root, filename)}")
                        continue  # Chuyển sang tệp tiếp theo

                    # Bạn có thể thêm các đuôi tệp khác cần bỏ qua ở đây
                    # Ví dụ: if filename.lower().endswith((".jpg", ".jpeg", ".gif")):
                    #     print(f"Bỏ qua tệp hình ảnh: {os.path.join(root, filename)}")
                    #     continue

                    # Nếu bạn muốn chỉ định rõ các loại tệp code cần đọc,
                    # bạn có thể bỏ comment phần dưới đây và điều chỉnh cho phù hợp.
                    # Lúc này, biến đếm sẽ chỉ tăng khi một tệp hợp lệ được xử lý.
                    # valid_extensions = (".js", ".py", ".html", ".css", ".java", ".cpp", ".c", ".txt")
                    # if not filename.lower().endswith(valid_extensions):
                    #     print(f"Bỏ qua tệp không phải mã nguồn được chỉ định: {os.path.join(root, filename)}")
                    #     continue

                    file_path = os.path.join(root, filename)
                    try:
                        with open(file_path, 'r', encoding='utf-8', errors='ignore') as infile:
                            content = infile.read()
                            outfile.write(f"{filename}:\n\n")
                            outfile.write(content)
                            outfile.write("\n\n\n") # Thêm khoảng trắng giữa các tệp
                        print(f"Đã sao chép nội dung từ: {file_path}")
                        code_file_count += 1  # Tăng biến đếm sau khi xử lý thành công một tệp mã
                    except UnicodeDecodeError:
                        print(f"Lỗi giải mã Unicode khi đọc tệp (có thể là tệp nhị phân không mong muốn): {file_path}. Bỏ qua tệp này.")
                    except Exception as e:
                        print(f"Lỗi khi đọc tệp {file_path}: {e}")
        print(f"\nHoàn tất! Tất cả nội dung đã được ghi vào: {output_file_path}")
        print(f"Tổng số tệp mã đã được xử lý và sao chép: {code_file_count}") # In tổng số tệp mã
    except Exception as e:
        print(f"Lỗi khi ghi vào tệp đầu ra {output_file_path}: {e}")

# Đường dẫn đến thư mục chứa code của bạn
source_dir = "/Users/locnguyen/Downloads/Calendar-sync-extension/calendar-sync-extension"
# Đường dẫn đến file txt bạn muốn lưu kết quả
output_txt_file = "/Users/locnguyen/Downloads/code_output.txt" # Bạn có thể thay đổi tên và vị trí tệp này

# Gọi hàm để thực hiện
read_code_files_to_txt(source_dir, output_txt_file)