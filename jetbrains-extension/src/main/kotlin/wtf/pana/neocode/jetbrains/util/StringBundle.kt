package wtf.pana.neocode.jetbrains.util

import com.intellij.DynamicBundle
import org.jetbrains.annotations.PropertyKey

/**
 * i18n / string resource bundle for the plugin.
 *
 * Loads from `/messages/NeocodeBundle.properties` on the classpath.
 * Usage: `StringBundle.message("action.send.text")`
 *
 * TODO: create /messages/NeocodeBundle.properties once we have user-facing strings.
 */
object StringBundle {
    private const val BUNDLE_NAME = "messages.NeocodeBundle"
    private val bundle = DynamicBundle(StringBundle::class.java, BUNDLE_NAME)

    @JvmStatic
    fun message(
        @PropertyKey(resourceBundle = BUNDLE_NAME) key: String,
        vararg params: Any,
    ): String = bundle.getMessage(key, *params)
}
