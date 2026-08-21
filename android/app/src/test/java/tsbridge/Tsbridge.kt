package tsbridge

/**
 * Test-only fixture standing in for the real gomobile-generated
 * `tsbridge.Tsbridge` class (see android/app/libs/tsbridge.aar, built by
 * scripts/build-tsbridge.sh). Method signatures here are copied verbatim
 * from `javap -p tsbridge.Tsbridge` run against the actual built .aar, so
 * TsBridgeBinder's reflection resolves against this exactly the way it
 * would against the real thing:
 *
 *   public static void prepare(String, String);
 *   public static long startForward(String, String, String, String, String) throws Exception;
 *   public static String status();
 *   public static void stop() throws Exception;
 *
 * `@JvmStatic` is required — without it, Kotlin's `object` only exposes
 * these as instance methods on a singleton `INSTANCE` field, not as true
 * `static` methods, which wouldn't match what gomobile actually generates
 * (and wouldn't be found by TsBridgeBinder's `Class.getMethod` calls, which
 * only look at declared/public methods reachable the way a static Java call
 * would resolve them).
 */
object Tsbridge {
    var lastPrepareArgs: Pair<String, String>? = null
    var lastStartForwardArgs: List<String>? = null
    var startForwardResult: Long = 4321L
    var startForwardShouldThrow: Boolean = false
    var stopShouldThrow: Boolean = false
    var statusResult: String = "{\"running\":true}"

    @JvmStatic
    fun prepare(cacheDir: String, homeDir: String) {
        lastPrepareArgs = cacheDir to homeDir
    }

    @JvmStatic
    @Throws(Exception::class)
    fun startForward(
        stateDir: String,
        hostname: String,
        authKey: String,
        controlURL: String,
        hubHostPort: String,
    ): Long {
        lastStartForwardArgs = listOf(stateDir, hostname, authKey, controlURL, hubHostPort)
        if (startForwardShouldThrow) {
            throw Exception("simulated tsnet failure")
        }
        return startForwardResult
    }

    @JvmStatic
    fun status(): String = statusResult

    @JvmStatic
    @Throws(Exception::class)
    fun stop() {
        if (stopShouldThrow) {
            throw Exception("simulated stop failure")
        }
    }
}
