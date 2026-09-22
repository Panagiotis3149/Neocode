package wtf.pana.neocode.jetbrains.util

import kotlin.test.Test
import kotlin.test.assertEquals

class TerminalUtilsTest {
    @Test
    fun `windows commands run through cmd wrapper`() {
        if (!System.getProperty("os.name").startsWith("Windows")) return

        assertEquals(
            listOf("cmd.exe", "/d", "/s", "/c", "\"C:\\Program Files\\Neocode\\neocode.exe\""),
            TerminalUtils.buildTerminalCommand("C:\\Program Files\\Neocode\\neocode.exe"),
        )
    }
}
