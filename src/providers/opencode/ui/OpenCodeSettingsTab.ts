import * as fs from 'fs';
import { Setting } from 'obsidian';

import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { renderEnvironmentSettingsSection } from '../../../features/settings/ui/EnvironmentSettingsSection';
import { t } from '../../../i18n/i18n';
import { expandHomePath } from '../../../utils/path';
import { getOpenCodeProviderSettings, setOpenCodeProviderSettings } from '../settings';

export const openCodeSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const openCodeSettings = getOpenCodeProviderSettings(settingsBag);

    // --- Setup ---

    new Setting(container).setName(t('settings.setup')).setHeading();

    new Setting(container)
      .setName('Enable OpenCode provider')
      .setDesc('When enabled, OpenCode models appear in the model selector for new conversations.')
      .addToggle((toggle) =>
        toggle
          .setValue(openCodeSettings.enabled)
          .onChange(async (value) => {
            setOpenCodeProviderSettings(settingsBag, { enabled: value });
            await context.plugin.saveSettings();
            context.refreshModelSelectors();
          })
      );

    const cliPathSetting = new Setting(container)
      .setName('OpenCode CLI path')
      .setDesc('Custom path to the local OpenCode CLI. Leave empty for auto-detection from PATH.');

    const validationEl = container.createDiv({ cls: 'claudian-cli-path-validation' });
    validationEl.style.color = 'var(--text-error)';
    validationEl.style.fontSize = '0.85em';
    validationEl.style.marginTop = '-0.5em';
    validationEl.style.marginBottom = '0.5em';
    validationEl.style.display = 'none';

    const validatePath = (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) return null;

      try {
        const expandedPath = expandHomePath(trimmed);
        if (!fs.existsSync(expandedPath)) {
          return `File not found: ${expandedPath}`;
        }
        if (!fs.statSync(expandedPath).isFile()) {
          return 'Path exists but is not a file.';
        }
      } catch (error) {
        return `Failed to validate path: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }

      return null;
    };

    const updateValidationUI = (value: string): void => {
      const error = validatePath(value);
      if (error) {
        validationEl.textContent = error;
        validationEl.style.display = 'block';
      } else {
        validationEl.style.display = 'none';
      }
    };

    cliPathSetting.addText((text) => {
      text
        .setPlaceholder(process.platform === 'win32'
          ? 'C:\\Users\\you\\.opencode\\bin\\opencode.exe'
          : '/usr/local/bin/opencode')
        .setValue(openCodeSettings.customCliPath)
        .onChange(async (value) => {
          updateValidationUI(value);
          setOpenCodeProviderSettings(settingsBag, { customCliPath: value.trim() });
          await context.plugin.saveSettings();
        });
    });

    // --- Safe Mode ---

    new Setting(container)
      .setName('Safe mode')
      .setDesc('Default sandbox level for OpenCode sessions. Controls what file/system access the AI agent has.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('workspace-write', 'Workspace Write (default)')
          .addOption('workspace-read', 'Workspace Read Only')
          .addOption('none', 'None (full access)')
          .setValue(openCodeSettings.safeMode)
          .onChange(async (value) => {
            setOpenCodeProviderSettings(settingsBag, {
              safeMode: value as 'workspace-write' | 'workspace-read' | 'none',
            });
            await context.plugin.saveSettings();
          });
      });

    // --- Environment Variables ---

    renderEnvironmentSettingsSection({
      container,
      plugin: context.plugin,
      scope: 'provider:opencode',
      heading: t('settings.environment'),
      name: 'OpenCode environment',
      desc: 'Configure environment variables for the OpenCode CLI process (e.g., OPENCODE_MODEL, OPENCODE_API_KEY, custom PATH).',
      placeholder: 'OPENCODE_MODEL=claude-sonnet-4\nOPENCODE_API_KEY=your-key\nOPENCODE_BASE_URL=https://api.anthropic.com',
      renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'opencode'),
    });

    // --- Hidden Provider Commands ---

    context.renderHiddenProviderCommandSetting(container, 'opencode', {
      name: 'Hidden skills',
      desc: 'Skills to hide from the dropdown. Separate multiple names with commas.',
      placeholder: 'skill-name-1, skill-name-2',
    });
  },
};
