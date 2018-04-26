import React from 'react';
import styled from 'styled-components';
// import PropTypes from 'prop-types';
import { connect } from 'react-redux';

import AppBar from 'material-ui/AppBar';
import MaterialToolbar from 'material-ui/Toolbar';
import IconButton from 'material-ui/IconButton';
import MenuIcon from 'material-ui-icons/Menu';

import NavigationPanel from './NavigationPanel';

const Container = styled(AppBar)`
  min-height: 5vh;
`;

const Logo = styled.img`
  && {
    height: 50px;
    width: auto;
  }
`;

const Toolbar = styled(MaterialToolbar)`
  && {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
`;

const LineBlock = styled.div`
  display: flex;
  align-items: center;
`;

class Header extends React.PureComponent {
  state = { isPanelOpened: false };

  togglePanel = () => {
    this.setState({ isPanelOpened: !this.state.isPanelOpened });
  };

  render() {
    return (
      <Container position="static" color="primary">
        <Toolbar>
          <LineBlock>
            <IconButton
              onClick={this.togglePanel}
              color="default"
              aria-label="Menu"
            >
              <MenuIcon />
            </IconButton>
            <Logo src="/statics/logo.png" alt="Gennaro Anesi" />
          </LineBlock>
        </Toolbar>
        <NavigationPanel
          isOpened={this.state.isPanelOpened}
          toggle={this.togglePanel}
        />
      </Container>
    );
  }
}

/*
const mapStateToProps = state => ({
  username: state.get('user').get('name'),
});
*/

export default connect()(Header);
