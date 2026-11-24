"""Optional desktop launcher. The game itself lives in index.html and src/."""

from pathlib import Path
import sys


def resource_path(relative_path):
    """Resolve assets independently of the working directory, including frozen apps."""
    base_path = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parent))
    return str(base_path / relative_path)


def main():
    # Import only when launching: repository checks do not require a GUI toolkit.
    import webview

    file_path = resource_path('index.html')
    webview.create_window('Hotline Circles', file_path, width=1280, height=720, resizable=True)
    webview.start()


if __name__ == '__main__':
    main()
