package app.floatphone.shell

import android.util.Base64
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.io.OutputStream

/** User selects the destination; bounded chunks avoid a full base64 copy of a backup. */
class NativeFileSaver(private val activity: AppCompatActivity, private val emit: (String) -> Unit) {
    private data class Save(val id: String, val bytes: Long, var written: Long = 0, var stream: OutputStream? = null)
    private var current: Save? = null
    private var pickerOpen = false
    private val picker = activity.registerForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        synchronized(this) {
            pickerOpen = false
            val save = current ?: return@registerForActivityResult
            if (uri == null) {
                current = null
                event(save.id, "cancelled")
            } else {
                try {
                    save.stream = activity.contentResolver.openOutputStream(uri, "w")
                        ?: throw IllegalStateException("无法打开目标文件")
                    event(save.id, "ready")
                } catch (_: Exception) {
                    current = null
                    event(save.id, "error")
                }
            }
        }
    }

    @Synchronized
    fun begin(id: String, filename: String, bytes: Long): Boolean {
        if (current != null || pickerOpen || !id.matches(Regex("[a-zA-Z0-9-]{1,80}")) || bytes < 0 || bytes > 1024L * 1024 * 1024) return false
        current = Save(id, bytes)
        pickerOpen = true
        val name = filename.replace(Regex("[/\\\\\u0000-\u001f]"), "_").take(160).ifBlank { "float-backup.zip" }
        activity.runOnUiThread {
            runCatching { picker.launch(name) }.onFailure {
                synchronized(this) { current = null; pickerOpen = false }
                event(id, "error")
            }
        }
        return true
    }

    @Synchronized
    fun chunk(id: String, value: String): Boolean {
        val save = current ?: return false
        if (save.id != id || save.stream == null || value.length > 350000) return false
        return try {
            val bytes = Base64.decode(value, Base64.NO_WRAP)
            if (bytes.size > 262144 || save.written + bytes.size > save.bytes) return false
            save.stream!!.write(bytes)
            save.written += bytes.size
            true
        } catch (_: Exception) { cancel(id); false }
    }

    @Synchronized
    fun finish(id: String): Boolean {
        val save = current ?: return false
        if (save.id != id || save.stream == null || save.written != save.bytes) return false
        return try {
            save.stream!!.flush()
            save.stream!!.close()
            current = null
            true
        } catch (_: Exception) { cancel(id); false }
    }

    @Synchronized
    fun cancel(id: String) {
        if (current?.id != id) return
        runCatching { current?.stream?.close() }
        current = null
    }

    @Synchronized
    fun close() { current?.id?.let { cancel(it) } }

    private fun event(id: String, status: String) {
        emit(JSONObject().put("id", id).put("status", status).toString())
    }
}
