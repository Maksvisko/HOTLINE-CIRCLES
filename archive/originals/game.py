import webview
import sys
import os

def resource_path(relative_path):
    """ Получает абсолютный путь к ресурсам, работает и для dev, и для PyInstaller """
    try:
        # PyInstaller создает временную папку и хранит путь в _MEIPASS
        base_path = sys._MEIPASS
    except Exception:
        base_path = os.path.abspath(".")

    return os.path.join(base_path, relative_path)

if __name__ == '__main__':
    # Указываем путь к HTML
    file_path = resource_path('index.html')
    
    # Запускаем окно
    # gui='cef' можно добавить для использования Chromium, но по умолчанию используется Edge (WebView2)
    webview.create_window('Hotline Circles', file_path, width=1280, height=720, resizable=True)
    webview.start()