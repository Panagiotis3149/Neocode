package wtf.pana.neocode.jetbrains.settings

import com.intellij.openapi.options.Configurable
import java.awt.BorderLayout
import javax.swing.BoxLayout
import javax.swing.JCheckBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel

/**
 * Configurable UI for Neocode plugin settings.
 *
 * This class implements IntelliJ's [Configurable] interface to provide a settings panel
 * in the IDE's Settings/Preferences dialog. It allows users to configure Neocode
 * behavior such as automatic restart when the terminal process exits.
 *
 * The settings are persisted through [NeocodeSettings] and include:
 * - Auto-restart on exit: Whether Neocode should automatically restart after termination
 *
 * Lifecycle:
 * - [createComponent]: Creates the UI components when the settings dialog opens
 * - [reset]: Loads current settings into the UI
 * - [isModified]: Checks if user made changes
 * - [apply]: Saves user changes to persistent storage
 * - [disposeUIResources]: Cleans up UI references when dialog closes
 */
class NeocodeConfigurable : Configurable {

    private var settingsPanel: JPanel? = null
    private var autoRestartCheckbox: JCheckBox? = null

    override fun getDisplayName(): String = "Neocode"

    /**
     * Creates the settings UI component.
     *
     * @return The root JComponent containing all settings controls
     */
    override fun createComponent(): JComponent {
        val panel = JPanel(BorderLayout())
        val formPanel = JPanel()
        formPanel.layout = BoxLayout(formPanel, BoxLayout.Y_AXIS)

        // Auto-restart checkbox
        autoRestartCheckbox = JCheckBox("Automatically restart Neocode when terminal exits")
        formPanel.add(autoRestartCheckbox)

        // Help text
        val helpLabel = JLabel(
            "<html><font size='-2' color='gray'>" +
                "When enabled, Neocode will automatically restart when the process exits.<br>" +
                "Applies to the tool window terminal session." +
            "</font></html>"
        )
        helpLabel.border = javax.swing.BorderFactory.createEmptyBorder(8, 0, 0, 0)
        formPanel.add(helpLabel)

        panel.add(formPanel, BorderLayout.NORTH)
        settingsPanel = panel
        return panel
    }

    /**
     * Checks if the user has modified any settings.
     *
     * @return true if settings have been changed, false otherwise
     */
    override fun isModified(): Boolean {
        val settings = NeocodeSettings.getInstance()
        val currentState = settings.state
        val uiState = autoRestartCheckbox?.isSelected ?: false
        return currentState.autoRestartOnExit != uiState
    }

    /**
     * Loads current settings into the UI.
     */
    override fun reset() {
        val settings = NeocodeSettings.getInstance()
        autoRestartCheckbox?.isSelected = settings.state.autoRestartOnExit
    }

    /**
     * Applies user changes to persistent storage.
     */
    override fun apply() {
        val settings = NeocodeSettings.getInstance()
        settings.state.autoRestartOnExit = autoRestartCheckbox?.isSelected ?: false
    }

    /**
     * Cleans up UI references when the settings dialog closes.
     */
    override fun disposeUIResources() {
        settingsPanel = null
        autoRestartCheckbox = null
    }
}