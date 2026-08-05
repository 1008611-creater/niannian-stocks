package fun.cauai.niannianstocks;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void load() {
        registerPlugin(DeepLinkPlugin.class);
        super.load();
    }
}
