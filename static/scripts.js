// Hiển thị thanh loading khi submit form
function showLoading() {
    const overlay = document.createElement('div');
    overlay.className = 'loading-overlay';
    overlay.innerHTML = `
        <div>
            <div class="loading-bar"></div>
            <div class="loading-text">Đang xử lý, vui lòng chờ...</div>
        </div>
    `;
    document.body.appendChild(overlay);
}

// Gắn sự kiện submit cho form
document.addEventListener('DOMContentLoaded', function() {
    const forms = document.querySelectorAll('form');
    forms.forEach(form => {
        form.addEventListener('submit', function() {
            showLoading();
        });
    });
});