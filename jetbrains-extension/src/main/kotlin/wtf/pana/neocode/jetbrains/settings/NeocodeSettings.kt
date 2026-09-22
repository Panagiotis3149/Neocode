package wtf.pana.neocode.jetbrains.settings

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

/**
 * Stores plugin configuration for Neocode.
 *
 * This service manages persistent settings that are saved across IDE restarts.
 * Settings are stored in `neocode.xml` and automatically loaded by IntelliJ's persistence framework.
 */
@State(
    name = "NeocodeSettings",
    storages = [Storage("neocode.xml")]
)
@Service(Service.Level.APP)
class NeocodeSettings : PersistentStateComponent<NeocodeSettings.State> {

    /**
     * Holds persistent settings for the Neocode plugin.
     *
     * These settings are automatically saved and loaded by IntelliJ's persistence framework.
     * Changes to properties are persisted when the IDE closes or settings are modified.
     *
     * @property autoRestartOnExit Whether to automatically restart the Neocode server when the terminal process exits.
     * If true, the server will be restarted when the tool window terminal exits unexpectedly.
     */
    data class State(
        @Suppress("DataClassShouldBeImmutable")
        var autoRestartOnExit: Boolean = false,
        @Suppress("DataClassShouldBeImmutable")
        var sessionLimit: Int = 100
    )

    private var myState = State()

    /**
     * Returns the current state of the settings.
     *
     * This method is called by IntelliJ's persistence framework to save the current settings.
     *
     * @return The current State object containing all plugin settings
     */
    override fun getState(): State = myState

    /**
     * Loads the settings state from persisted storage.
     *
     * This method is called by IntelliJ's persistence framework to restore the settings
     * from the persisted storage when the IDE starts or settings are reloaded.
     *
     * @param state The State object to load, containing persisted settings values
     */
    override fun loadState(state: State) {
        myState = state
    }

    companion object {
        /**
         * Returns the singleton instance of NeocodeSettings.
         *
         * @return The NeocodeSettings instance for the application
         */
        fun getInstance(): NeocodeSettings = com.intellij.openapi.components.service<NeocodeSettings>()
    }
}