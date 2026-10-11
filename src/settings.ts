import {
  AbstractInputSuggest, Notice, PluginSettingTab, Setting, normalizePath, type App, type Plugin,
} from "obsidian";

export interface PdfPagerSettings {
  version: 2;
  noteLinks: Record<string, string>;
  recordFolder: string;
  idleMinutes: number;
}

export interface PdfPagerSettingsController {
  getPdfPagerSettings(): PdfPagerSettings;
  updateRecordFolder(path: string): Promise<void>;
  updateIdleMinutes(minutes: number): Promise<void>;
}

type FolderChoice = { path: string } | { empty: true };

class FolderSuggest extends AbstractInputSuggest<FolderChoice> {
  constructor(app: App, input: HTMLInputElement, private choose: (path: string) => void) {
    super(app, input);
    this.limit = 30;
  }

  protected getSuggestions(query: string): FolderChoice[] {
    const needle = query.trim().toLocaleLowerCase();
    const paths = this.app.vault.getAllFolders()
      .map((folder) => folder.path)
      .filter(Boolean)
      .filter((path) => !needle || path.toLocaleLowerCase().includes(needle))
      .sort((a, b) => a.localeCompare(b, "zh-CN"))
      .slice(0, this.limit);
    return paths.length ? paths.map((path) => ({ path })) : [{ empty: true }];
  }

  renderSuggestion(choice: FolderChoice, element: HTMLElement): void {
    if ("empty" in choice) {
      element.createDiv({ cls: "suggestion-note", text: "没有匹配目录；可直接输入新的 Vault 内路径" });
      return;
    }
    element.createDiv({ text: choice.path.slice(choice.path.lastIndexOf("/") + 1) });
    element.createDiv({ cls: "suggestion-note", text: choice.path });
  }

  selectSuggestion(choice: FolderChoice): void {
    if ("empty" in choice) return;
    this.setValue(choice.path);
    this.choose(choice.path);
    this.close();
  }
}

export function normalizeRecordFolder(value: string, fallback: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return fallback;
  if (trimmed.split("/").some((part) => part === "..") || /^[a-z]+:\/\//i.test(trimmed)) {
    throw new Error("记录目录必须是 Vault 内的相对文件夹路径");
  }
  return normalizePath(trimmed);
}

export class PdfPagerSettingTab extends PluginSettingTab {
  constructor(app: App, plugin: Plugin & PdfPagerSettingsController) {
    super(app, plugin);
    this.controller = plugin;
  }

  private controller: PdfPagerSettingsController;

  getSettingDefinitions(): [] { return []; }

  display(): void {
    const { containerEl } = this;
    const settings = this.controller.getPdfPagerSettings();
    containerEl.empty();

    const folderSetting = new Setting(containerEl)
      .setName("阅读记录目录")
      .setDesc("Vault 内的文件夹路径。修改后会把现有记录复制过去；两台设备需设置相同路径，并让同步软件包含该目录。");
    folderSetting.addText((text) => {
      text.setValue(settings.recordFolder).setPlaceholder("99_assets/plugin-data/reading-records");
      text.inputEl.setAttr("aria-label", "PDF 阅读记录文件夹路径");
      const apply = async (value: string) => {
        try {
          await this.controller.updateRecordFolder(value);
          text.setValue(this.controller.getPdfPagerSettings().recordFolder);
          text.inputEl.removeAttribute("aria-invalid");
        } catch (error) {
          text.inputEl.setAttribute("aria-invalid", "true");
          text.setValue(this.controller.getPdfPagerSettings().recordFolder);
          new Notice(String(error instanceof Error ? error.message : error));
        }
      };
      text.inputEl.addEventListener("blur", () => void apply(text.getValue()));
      new FolderSuggest(this.app, text.inputEl, (path) => void apply(path));
    });

    new Setting(containerEl)
      .setName("无操作暂停计时")
      .setDesc("停留在同一页且没有触控、滚动或翻页达到此时间后暂停。切到后台会立即暂停。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("5", "5 分钟")
          .addOption("10", "10 分钟")
          .addOption("15", "15 分钟")
          .addOption("30", "30 分钟")
          .setValue(String(settings.idleMinutes))
          .onChange(async (value) => {
            await this.controller.updateIdleMinutes(Number(value));
            new Notice(`PDF 阅读计时会在无操作 ${value} 分钟后暂停`);
          });
      });
  }
}
