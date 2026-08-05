package fun.cauai.niannianstocks;

import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DeepLink")
public class DeepLinkPlugin extends Plugin {
    @Override
    protected void handleOnNewIntent(Intent intent) {
        emitAppUrl(intent);
    }

    private void emitAppUrl(Intent intent) {
        Uri uri = intent == null ? null : intent.getData();
        if (uri == null || !"fun.cauai.niannianstocks".equals(uri.getScheme())) {
            return;
        }
        JSObject event = new JSObject();
        event.put("url", uri.toString());
        notifyListeners("appUrlOpen", event, true);
    }
}
