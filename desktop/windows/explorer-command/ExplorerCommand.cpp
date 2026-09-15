#define STRICT
#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <new>
#include <string.h>

#include <windows.h>
#include <initguid.h>
#include <shlobj.h>
#include <shlwapi.h>

#ifdef _MSC_VER
#pragma comment(lib, "ole32")
#pragma comment(lib, "oleaut32")
#pragma comment(lib, "shell32")
#pragma comment(lib, "shlwapi")
#pragma comment(lib, "uuid")
// combaseapi.h already declares DllGetClassObject / DllCanUnloadNow; do not
// add dllexport here (C2375). The .def file passed via /link /DEF publishes them.
#define FB_DLLEXPORT extern "C"
#else
#define FB_DLLEXPORT extern "C" __attribute__((dllexport))
#endif

// Keep in sync with identity.json — tests assert the same CLSID.
// {5C8A1E2D-9B74-4A16-8F3C-6E2D91B0487A}
static const CLSID CLSID_FreeBuddyExplorerCommand = {
    0x5c8a1e2d,
    0x9b74,
    0x4a16,
    {0x8f, 0x3c, 0x6e, 0x2d, 0x91, 0xb0, 0x48, 0x7a}};

static const wchar_t kOpenFlag[] = L"--open";
static const int kMaxOpenPaths = 32;
static const int kMaxPathChars = 1024;
static const int kMaxCommandChars = 32768;

static volatile LONG g_moduleLocks = 0;

static void AddModuleLock() { InterlockedIncrement(&g_moduleLocks); }
static void ReleaseModuleLock() { InterlockedDecrement(&g_moduleLocks); }

static void* AllocObject(size_t bytes) {
  return HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, bytes);
}

static void FreeObject(void* memory) {
  if (memory) HeapFree(GetProcessHeap(), 0, memory);
}

static bool AppendText(wchar_t* dest, int destSize, const wchar_t* text) {
  const int used = lstrlenW(dest);
  const int add = lstrlenW(text);
  if (used + add + 1 > destSize) return false;
  memcpy(dest + used, text, (add + 1) * sizeof(wchar_t));
  return true;
}

static bool AppendQuoted(wchar_t* dest, int destSize, const wchar_t* value) {
  if (!AppendText(dest, destSize, L"\"")) return false;
  for (const wchar_t* cursor = value; *cursor; ++cursor) {
    if (*cursor == L'"' && !AppendText(dest, destSize, L"\\")) return false;
    wchar_t ch[2] = {*cursor, L'\0'};
    if (!AppendText(dest, destSize, ch)) return false;
  }
  return AppendText(dest, destSize, L"\"");
}

static bool GetThisDllPath(wchar_t* buffer, DWORD size) {
  HMODULE module = nullptr;
  if (!GetModuleHandleExW(
          GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
          reinterpret_cast<LPCWSTR>(&GetThisDllPath),
          &module)) {
    return false;
  }
  const DWORD written = GetModuleFileNameW(module, buffer, size);
  return written > 0 && written < size;
}

static bool GetInstallDir(wchar_t* buffer, DWORD size) {
  if (!GetThisDllPath(buffer, size)) return false;
  PathRemoveFileSpecW(buffer);
  return buffer[0] != L'\0';
}

static bool FileExists(const wchar_t* path) {
  const DWORD attrs = GetFileAttributesW(path);
  return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

static bool JoinPath(wchar_t* buffer, DWORD size, const wchar_t* dir, const wchar_t* name) {
  const size_t dirLen = wcslen(dir);
  const size_t nameLen = wcslen(name);
  const bool needSlash = dirLen > 0 && dir[dirLen - 1] != L'\\' && dir[dirLen - 1] != L'/';
  const size_t total = dirLen + (needSlash ? 1 : 0) + nameLen + 1;
  if (total > size) return false;
  memcpy(buffer, dir, dirLen * sizeof(wchar_t));
  size_t offset = dirLen;
  if (needSlash) buffer[offset++] = L'\\';
  memcpy(buffer + offset, name, (nameLen + 1) * sizeof(wchar_t));
  return true;
}

static bool GetFreeBuddyExePath(wchar_t* buffer, DWORD size) {
  wchar_t dir[32768];
  if (!GetInstallDir(dir, ARRAYSIZE(dir))) return false;
  static const wchar_t* kExeNames[] = {L"FreeBuddy.exe", L"FreeBuddy Dev.exe"};
  for (const wchar_t* name : kExeNames) {
    if (JoinPath(buffer, size, dir, name) && FileExists(buffer)) return true;
  }
  return JoinPath(buffer, size, dir, L"FreeBuddy.exe");
}

static bool IsChineseUi() {
  return PRIMARYLANGID(GetUserDefaultUILanguage()) == LANG_CHINESE;
}

static HRESULT DupTitle(LPWSTR* value) {
  return SHStrDupW(IsChineseUi() ? L"使用 FreeBuddy 打开" : L"Open with FreeBuddy", value);
}

static HRESULT AddShellItemPath(
    IShellItem* item,
    wchar_t paths[][kMaxPathChars],
    int* count
) {
  if (!item || !paths || !count) return E_INVALIDARG;
  if (*count >= kMaxOpenPaths) return S_OK;
  LPWSTR filePath = nullptr;
  const HRESULT hr = item->GetDisplayName(SIGDN_FILESYSPATH, &filePath);
  if (FAILED(hr)) return hr;
  if (filePath && filePath[0] && lstrlenW(filePath) < kMaxPathChars) {
    lstrcpynW(paths[*count], filePath, kMaxPathChars);
    *count += 1;
  }
  CoTaskMemFree(filePath);
  return S_OK;
}

static HRESULT CollectPaths(
    IShellItemArray* items,
    IUnknown* site,
    wchar_t paths[][kMaxPathChars],
    int* count
) {
  *count = 0;
  if (items) {
    DWORD itemCount = 0;
    if (SUCCEEDED(items->GetCount(&itemCount))) {
      for (DWORD i = 0; i < itemCount && *count < kMaxOpenPaths; ++i) {
        IShellItem* item = nullptr;
        if (SUCCEEDED(items->GetItemAt(i, &item)) && item) {
          AddShellItemPath(item, paths, count);
          item->Release();
        }
      }
    }
  }
  if (*count > 0 || !site) return S_OK;

  IServiceProvider* provider = nullptr;
  HRESULT hr = site->QueryInterface(IID_IServiceProvider, reinterpret_cast<void**>(&provider));
  if (FAILED(hr) || !provider) return hr;
  IFolderView* folderView = nullptr;
  hr = provider->QueryService(SID_SFolderView, IID_IFolderView, reinterpret_cast<void**>(&folderView));
  provider->Release();
  if (FAILED(hr) || !folderView) return hr;
  IShellItem* folder = nullptr;
  hr = folderView->GetFolder(IID_IShellItem, reinterpret_cast<void**>(&folder));
  folderView->Release();
  if (FAILED(hr) || !folder) return hr;
  hr = AddShellItemPath(folder, paths, count);
  folder->Release();
  return hr;
}

static HRESULT LaunchFreeBuddy(wchar_t paths[][kMaxPathChars], int count) {
  if (count <= 0) return S_OK;
  wchar_t exe[32768];
  if (!GetFreeBuddyExePath(exe, ARRAYSIZE(exe))) return HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);

  wchar_t command[kMaxCommandChars];
  command[0] = L'\0';
  if (!AppendQuoted(command, kMaxCommandChars, exe)) return E_OUTOFMEMORY;
  for (int i = 0; i < count; ++i) {
    if (!AppendText(command, kMaxCommandChars, L" ") ||
        !AppendText(command, kMaxCommandChars, kOpenFlag) ||
        !AppendText(command, kMaxCommandChars, L" ") ||
        !AppendQuoted(command, kMaxCommandChars, paths[i])) {
      return E_OUTOFMEMORY;
    }
  }

  STARTUPINFOW si;
  ZeroMemory(&si, sizeof(si));
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi;
  ZeroMemory(&pi, sizeof(pi));
  const BOOL ok = CreateProcessW(exe, command, nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi);
  if (!ok) return HRESULT_FROM_WIN32(GetLastError());
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return S_OK;
}

class ExplorerCommand final : public IExplorerCommand, public IObjectWithSite {
 public:
  ExplorerCommand() { AddModuleLock(); }

  void Destroy() {
    SetSite(nullptr);
    ReleaseModuleLock();
    this->~ExplorerCommand();
    FreeObject(this);
  }

  IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, IID_IExplorerCommand)) {
      *ppv = static_cast<IExplorerCommand*>(this);
    } else if (IsEqualIID(riid, IID_IObjectWithSite)) {
      *ppv = static_cast<IObjectWithSite*>(this);
    } else {
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }

  IFACEMETHODIMP_(ULONG) AddRef() override {
    return static_cast<ULONG>(InterlockedIncrement(&ref_));
  }

  IFACEMETHODIMP_(ULONG) Release() override {
    const LONG value = InterlockedDecrement(&ref_);
    if (value == 0) Destroy();
    return static_cast<ULONG>(value);
  }

  IFACEMETHODIMP GetTitle(IShellItemArray*, LPWSTR* name) override {
    if (!name) return E_POINTER;
    return DupTitle(name);
  }

  IFACEMETHODIMP GetIcon(IShellItemArray*, LPWSTR* icon) override {
    if (!icon) return E_POINTER;
    *icon = nullptr;
    wchar_t exe[32768];
    if (!GetFreeBuddyExePath(exe, ARRAYSIZE(exe))) return E_FAIL;
    return SHStrDupW(exe, icon);
  }

  IFACEMETHODIMP GetToolTip(IShellItemArray*, LPWSTR* infotip) override {
    if (!infotip) return E_POINTER;
    *infotip = nullptr;
    return E_NOTIMPL;
  }

  IFACEMETHODIMP GetCanonicalName(GUID* commandName) override {
    if (!commandName) return E_POINTER;
    *commandName = CLSID_FreeBuddyExplorerCommand;
    return S_OK;
  }

  IFACEMETHODIMP GetState(IShellItemArray*, BOOL, EXPCMDSTATE* state) override {
    if (!state) return E_POINTER;
    *state = ECS_ENABLED;
    return S_OK;
  }

  IFACEMETHODIMP Invoke(IShellItemArray* items, IBindCtx*) override {
    wchar_t paths[kMaxOpenPaths][kMaxPathChars];
    int count = 0;
    const HRESULT hr = CollectPaths(items, site_, paths, &count);
    if (FAILED(hr)) return hr;
    return LaunchFreeBuddy(paths, count);
  }

  IFACEMETHODIMP GetFlags(EXPCMDFLAGS* flags) override {
    if (!flags) return E_POINTER;
    *flags = ECF_DEFAULT;
    return S_OK;
  }

  IFACEMETHODIMP EnumSubCommands(IEnumExplorerCommand** commands) override {
    if (!commands) return E_POINTER;
    *commands = nullptr;
    return E_NOTIMPL;
  }

  IFACEMETHODIMP SetSite(IUnknown* site) override {
    if (site_) {
      site_->Release();
      site_ = nullptr;
    }
    if (site) {
      site_ = site;
      site_->AddRef();
    }
    return S_OK;
  }

  IFACEMETHODIMP GetSite(REFIID riid, void** site) override {
    if (!site) return E_POINTER;
    *site = nullptr;
    if (!site_) return E_FAIL;
    return site_->QueryInterface(riid, site);
  }

 private:
  ~ExplorerCommand() = default;
  LONG ref_ = 1;
  IUnknown* site_ = nullptr;
};

class ClassFactory final : public IClassFactory {
 public:
  ClassFactory() { AddModuleLock(); }

  void Destroy() {
    ReleaseModuleLock();
    this->~ClassFactory();
    FreeObject(this);
  }

  IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, IID_IClassFactory)) {
      *ppv = static_cast<IClassFactory*>(this);
      AddRef();
      return S_OK;
    }
    return E_NOINTERFACE;
  }

  IFACEMETHODIMP_(ULONG) AddRef() override {
    return static_cast<ULONG>(InterlockedIncrement(&ref_));
  }

  IFACEMETHODIMP_(ULONG) Release() override {
    const LONG value = InterlockedDecrement(&ref_);
    if (value == 0) Destroy();
    return static_cast<ULONG>(value);
  }

  IFACEMETHODIMP CreateInstance(IUnknown* outer, REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    if (outer) return CLASS_E_NOAGGREGATION;
    void* memory = AllocObject(sizeof(ExplorerCommand));
    if (!memory) return E_OUTOFMEMORY;
    ExplorerCommand* command = new (memory) ExplorerCommand();
    const HRESULT hr = command->QueryInterface(riid, ppv);
    command->Release();
    return hr;
  }

  IFACEMETHODIMP LockServer(BOOL lock) override {
    if (lock) AddModuleLock();
    else ReleaseModuleLock();
    return S_OK;
  }

 private:
  ~ClassFactory() = default;
  LONG ref_ = 1;
};

FB_DLLEXPORT HRESULT STDAPICALLTYPE DllGetClassObject(REFCLSID clsid, REFIID riid, void** ppv) {
  if (!ppv) return E_POINTER;
  *ppv = nullptr;
  if (!IsEqualCLSID(clsid, CLSID_FreeBuddyExplorerCommand)) return CLASS_E_CLASSNOTAVAILABLE;
  void* memory = AllocObject(sizeof(ClassFactory));
  if (!memory) return E_OUTOFMEMORY;
  ClassFactory* factory = new (memory) ClassFactory();
  const HRESULT hr = factory->QueryInterface(riid, ppv);
  factory->Release();
  return hr;
}

FB_DLLEXPORT HRESULT STDAPICALLTYPE DllCanUnloadNow() {
  return g_moduleLocks == 0 ? S_OK : S_FALSE;
}

FB_DLLEXPORT HRESULT STDAPICALLTYPE DllRegisterServer() { return S_OK; }
FB_DLLEXPORT HRESULT STDAPICALLTYPE DllUnregisterServer() { return S_OK; }

BOOL APIENTRY DllMain(HMODULE, DWORD, LPVOID) { return TRUE; }
