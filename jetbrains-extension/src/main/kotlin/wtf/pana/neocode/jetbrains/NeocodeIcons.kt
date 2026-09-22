package wtf.pana.neocode.jetbrains

import com.intellij.openapi.util.IconLoader
import javax.swing.Icon
import javax.swing.ImageIcon
import java.awt.Image
import java.awt.RenderingHints
import java.awt.Graphics2D
import java.awt.image.BufferedImage

/**
 * Neocode icon utilities. Loads the PNG from resources and provides
 * a scaled 16x16 ImageIcon with bicubic anti-aliasing for the tool window strip.
 */
object NeocodeIcons {
    private const val ICON_PATH = "/icons/neocode.png"
    private const val STRIP_SIZE = 16

    /** The raw PNG icon loaded from resources (500x500 source). */
    val NeocodeLogo: Icon = IconLoader.getIcon(ICON_PATH, NeocodeIcons::class.java)

    /**
     * Returns a 16x16 icon scaled with bicubic anti-aliasing for the
     * right-strip tool window button. Caches the result.
     */
    val NeocodeStripIcon: Icon by lazy {
        val src = NeocodeLogo as ImageIcon
        val srcImg = src.image
        val scaled = BufferedImage(STRIP_SIZE, STRIP_SIZE, BufferedImage.TYPE_INT_ARGB)
        val g2d = scaled.createGraphics()
        g2d.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC)
        g2d.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY)
        g2d.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        g2d.drawImage(srcImg, 0, 0, STRIP_SIZE, STRIP_SIZE, null)
        g2d.dispose()
        ImageIcon(scaled)
    }
}