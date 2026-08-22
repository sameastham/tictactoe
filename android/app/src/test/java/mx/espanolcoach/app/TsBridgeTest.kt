package mx.espanolcoach.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Exercises TsBridgeBinder (and, for the fully-wired path, the real
 * [TsBridge] object) against the fake `tsbridge.Tsbridge` fixture at
 * src/test/java/tsbridge/Tsbridge.kt — a stand-in for the gomobile-generated
 * class android/app/libs/tsbridge.aar provides at runtime.
 *
 * Covers both halves of the reflective-decoupling contract: method
 * resolution + invocation succeeding against a present class (mirroring the
 * .aar-bundled build), and the unavailable-fallback behaving safely against
 * a class that isn't there (mirroring a build with no .aar — see
 * TsBridge.kt's doc comment).
 */
class TsBridgeTest {
    @Before
    fun resetFake() {
        tsbridge.Tsbridge.lastPrepareArgs = null
        tsbridge.Tsbridge.lastStartForwardArgs = null
        tsbridge.Tsbridge.startForwardResult = 4321L
        tsbridge.Tsbridge.startForwardShouldThrow = false
        tsbridge.Tsbridge.stopShouldThrow = false
        tsbridge.Tsbridge.statusResult = "{\"running\":true}"
    }

    // --- resolved-and-working path (fake class present) ---------------

    @Test
    fun resolvesAllFourMethodsAgainstTheFakeClass() {
        val binder = TsBridgeBinder("TsBridgeTest", "tsbridge.Tsbridge")
        assertTrue(binder.isAvailable)
    }

    @Test
    fun prepareInvokesTheUnderlyingStaticMethodWithGivenArgs() {
        val binder = TsBridgeBinder("TsBridgeTest", "tsbridge.Tsbridge")
        binder.prepare("/cache", "/home")
        assertEquals("/cache" to "/home", tsbridge.Tsbridge.lastPrepareArgs)
    }

    @Test
    fun startForwardReturnsThePortAsIntConvertedFromTheUnderlyingLong() {
        tsbridge.Tsbridge.startForwardResult = 54321L
        val binder = TsBridgeBinder("TsBridgeTest", "tsbridge.Tsbridge")
        val port = binder.startForward("state", "host", "key", "", "hub:3000")
        assertEquals(54321, port)
        assertEquals(listOf("state", "host", "key", "", "hub:3000"), tsbridge.Tsbridge.lastStartForwardArgs)
    }

    @Test(expected = RuntimeException::class)
    fun startForwardUnwrapsTheUnderlyingException() {
        tsbridge.Tsbridge.startForwardShouldThrow = true
        val binder = TsBridgeBinder("TsBridgeTest", "tsbridge.Tsbridge")
        binder.startForward("state", "host", "key", "", "hub:3000")
    }

    @Test
    fun statusReturnsTheFakesJson() {
        tsbridge.Tsbridge.statusResult = "{\"running\":false}"
        val binder = TsBridgeBinder("TsBridgeTest", "tsbridge.Tsbridge")
        assertEquals("{\"running\":false}", binder.status())
    }

    @Test(expected = RuntimeException::class)
    fun stopUnwrapsTheUnderlyingException() {
        tsbridge.Tsbridge.stopShouldThrow = true
        val binder = TsBridgeBinder("TsBridgeTest", "tsbridge.Tsbridge")
        binder.stop()
    }

    @Test
    fun theRealTsBridgeObjectBindsSuccessfullyGivenTheFakeIsOnTheClasspath() {
        // TsBridge hardcodes CLASS_NAME = "tsbridge.Tsbridge", which is
        // exactly the fake fixture's name — this proves the actual
        // production wiring (not just TsBridgeBinder in isolation) resolves
        // against a real gomobile-shaped class.
        assertTrue(TsBridge.isAvailable)
        assertEquals("{\"running\":true}", TsBridge.status())
    }

    // --- unavailable-fallback path (class not found) -------------------

    @Test
    fun unavailableFallbackClassNotFoundLeavesEveryMethodUnresolved() {
        val binder = TsBridgeBinder("TsBridgeTest", "tsbridge.DoesNotExist")
        assertFalse(binder.isAvailable)
    }

    @Test
    fun unavailableFallbackStatusReturnsNullInsteadOfThrowing() {
        val binder = TsBridgeBinder("TsBridgeTest", "tsbridge.DoesNotExist")
        assertNull(binder.status())
    }

    @Test
    fun unavailableFallbackStopIsANoOpInsteadOfThrowing() {
        val binder = TsBridgeBinder("TsBridgeTest", "tsbridge.DoesNotExist")
        binder.stop() // must not throw even though the class is missing
    }

    @Test(expected = IllegalStateException::class)
    fun unavailableFallbackPrepareThrowsAClearErrorInsteadOfNpe() {
        val binder = TsBridgeBinder("TsBridgeTest", "tsbridge.DoesNotExist")
        binder.prepare("/cache", "/home")
    }

    @Test(expected = IllegalStateException::class)
    fun unavailableFallbackStartForwardThrowsAClearErrorInsteadOfNpe() {
        val binder = TsBridgeBinder("TsBridgeTest", "tsbridge.DoesNotExist")
        binder.startForward("state", "host", "key", "", "hub:3000")
    }
}
